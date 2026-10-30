import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  businessHoursStatus,
  isClientNonce,
  normalizeOrigin,
  normalizePhoneNumber,
  originAllowed,
  parseWidgetSettings,
  planVisitorAttachment,
  WEBCHAT_ATTACHMENTS_PER_HOUR,
  WEBCHAT_ATTACHMENT_MAX_BYTES,
  WEBCHAT_MAX_TEXT,
  type WebchatAttachment,
  type WebchatInboundPayload,
  type WidgetSettings,
} from "@support-automation/shared";
import { getMediaStorage } from "@/server/mediaStorage";
import { decryptSecret, encryptSecret } from "@support-automation/db";
import { platformPrisma, prisma } from "@/server/db";
import { disabledFeaturesFor } from "@/server/projectFeatures";
import { publicOrigin } from "@/server/google/oauth";
import { secretsEqual } from "@/server/channels/connections";

/**
 * Website live chat (WEBSITE_CHAT.md).
 *
 * The PUBLIC half (widget API, no session): the widget key in the URL names one WEBCHAT connection —
 * like a webhook key, it is the authority, read through the platform client with every write naming
 * the connection's own project. The browser's Origin must be one the widget lists (fails closed; it
 * stops other sites embedding it, not a determined script). A visitor is a random id plus a bearer
 * token stored only as a hash; a message is recorded as a ChannelInboundEvent and the worker turns it
 * into a conversation exactly as it does for Messenger and Telegram, so the inbox, AI and assignment
 * all apply unchanged. A visitor only ever reads their own conversation's sent messages — never a note,
 * a queued or failed reply, or another visitor's thread.
 *
 * The SETTINGS half (project-scoped, channels.manage) lives at the bottom.
 */

export class WebchatError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface PublicWidget {
  connectionId: string;
  projectId: string;
  name: string;
  enabled: boolean;
  settings: WidgetSettings;
  allowedOrigins: string[];
  identitySecret: string | null;
}

const KEY = /^[A-Za-z0-9_-]{20,64}$/;

/** The widget a key names, or null when there is none to serve (wrong key, disconnected, feature or project off). */
export async function loadPublicWidget(key: string): Promise<PublicWidget | null> {
  if (!KEY.test(key)) return null;
  const row = await platformPrisma.channelConnection.findUnique({
    where: { webhookKey: key },
    select: { id: true, projectId: true, type: true, status: true, enabled: true, name: true, widgetSettings: true, allowedOrigins: true, webhookSecretCiphertext: true },
  });
  if (!row || row.type !== "WEBCHAT" || row.status === "DISCONNECTED") return null;
  const project = await platformPrisma.project.findUnique({ where: { id: row.projectId }, select: { status: true, billingHoldAt: true } });
  if (!project || project.status !== "ACTIVE" || project.billingHoldAt) return null;
  if ((await disabledFeaturesFor(row.projectId)).has("OMNICHANNEL")) return null;
  let identitySecret: string | null = null;
  if (row.webhookSecretCiphertext) {
    try {
      identitySecret = decryptSecret(row.webhookSecretCiphertext);
    } catch {
      identitySecret = null;
    }
  }
  return {
    connectionId: row.id,
    projectId: row.projectId,
    name: row.name,
    enabled: row.enabled,
    settings: parseWidgetSettings(row.widgetSettings),
    allowedOrigins: row.allowedOrigins,
    identitySecret,
  };
}

/** CORS headers for an allowed origin; null when the origin may not use this widget. */
export function corsFor(widget: PublicWidget, origin: string | null): Record<string, string> | null {
  if (!originAllowed(origin, widget.allowedOrigins)) return null;
  return {
    "Access-Control-Allow-Origin": origin!,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const ipSalt = () => process.env.NEXTAUTH_SECRET ?? "webchat";
const clean = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().replace(/\s+/g, " ").slice(0, max) : null);

export interface VisitorSession {
  visitorId: string;
  token: string | null;
  verified: boolean;
}

/**
 * Starts a visitor, or resumes the one a still-valid token names. A name / email the visitor typed is
 * kept but shown as "(unverified)"; only a signature from the site (HMAC-SHA256 of its user id with
 * the widget's identity secret) marks the visitor verified.
 */
export async function startVisitor(
  widget: PublicWidget,
  input: { token?: unknown; name?: unknown; email?: unknown; identity?: unknown; ip: string | null; now?: Date },
): Promise<VisitorSession> {
  const now = input.now ?? new Date();
  if (typeof input.token === "string" && input.token.length >= 32) {
    const existing = await platformPrisma.webChatVisitor.findUnique({ where: { tokenHash: sha256(input.token) }, select: { id: true, connectionId: true, verifiedExternalId: true } });
    if (existing && existing.connectionId === widget.connectionId) return { visitorId: existing.id, token: null, verified: Boolean(existing.verifiedExternalId) };
  }

  const ipHash = input.ip ? sha256(`${ipSalt()}|${input.ip}`) : null;
  if (ipHash) {
    const recent = await platformPrisma.webChatVisitor.count({ where: { ipHash, createdAt: { gte: new Date(now.getTime() - 3_600_000) } } });
    if (recent >= 30) throw new WebchatError("Too many new chats from this network. Try again later.", 429);
  }

  let verifiedExternalId: string | null = null;
  const identity = input.identity && typeof input.identity === "object" ? (input.identity as Record<string, unknown>) : null;
  if (identity && widget.identitySecret && typeof identity.id === "string" && typeof identity.hash === "string" && identity.id.length <= 128) {
    const expected = createHmac("sha256", widget.identitySecret).update(identity.id).digest("hex");
    if (secretsEqual(identity.hash.toLowerCase(), expected)) verifiedExternalId = identity.id;
  }
  const name = clean(verifiedExternalId ? identity?.name : input.name, 80);
  // A phone number counts only with its OWN signature, HMAC-SHA256(secret, "phone:<id>:<phone>"): the user-id
  // hash says who is signed in, not which number is theirs, and the number is what links them to a client.
  let phone: string | null = null;
  if (verifiedExternalId && widget.identitySecret && typeof identity?.phone === "string" && typeof identity.phoneHash === "string" && identity.phone.length <= 40) {
    const expectedPhone = createHmac("sha256", widget.identitySecret).update(`phone:${verifiedExternalId}:${identity.phone}`).digest("hex");
    if (secretsEqual(identity.phoneHash.toLowerCase(), expectedPhone)) phone = normalizePhoneNumber(identity.phone);
  }
  const emailRaw = clean(verifiedExternalId ? identity?.email : input.email, 120);
  const email = emailRaw && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw) ? emailRaw : null;

  const visitorId = `v_${randomBytes(18).toString("base64url")}`;
  const token = randomBytes(32).toString("base64url");
  await platformPrisma.webChatVisitor.create({
    data: { id: visitorId, projectId: widget.projectId, connectionId: widget.connectionId, tokenHash: sha256(token), verifiedExternalId, name, email, phone, ipHash, createdAt: now, lastSeenAt: now },
  });
  return { visitorId, token, verified: Boolean(verifiedExternalId) };
}

export interface Visitor {
  id: string;
  name: string | null;
  email: string | null;
  verified: boolean;
}

/** The visitor a bearer token names on this widget, or null. */
export async function visitorFromToken(widget: PublicWidget, authorization: string | null): Promise<Visitor | null> {
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : null;
  if (!token || token.length < 32 || token.length > 128) return null;
  const v = await platformPrisma.webChatVisitor.findUnique({ where: { tokenHash: sha256(token) }, select: { id: true, connectionId: true, name: true, email: true, verifiedExternalId: true, lastSeenAt: true } });
  if (!v || v.connectionId !== widget.connectionId) return null;
  if (Date.now() - v.lastSeenAt.getTime() > 60_000) {
    await platformPrisma.webChatVisitor.update({ where: { id: v.id }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
  }
  return { id: v.id, name: v.name, email: v.email, verified: Boolean(v.verifiedExternalId) };
}

/** The page a visitor is on, kept only when it is on one of the widget's listed websites. */
function pageOn(widget: PublicWidget, raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 1000) return null;
  try {
    const url = new URL(raw);
    if (!widget.allowedOrigins.includes(normalizeOrigin(url.origin) ?? "")) return null;
    // Path only: a query string can carry a password-reset token or someone's email.
    return `${url.origin}${url.pathname}`.slice(0, 500);
  } catch {
    return null;
  }
}

/** Whether the team is answering now, for the widget and for marking messages sent out of hours. */
export function widgetAvailability(widget: PublicWidget, now: Date = new Date()) {
  return businessHoursStatus(widget.settings.hours, now);
}

/** Records one visitor message for the worker. A repeated nonce is the same message (no duplicate). */
export async function recordVisitorMessage(widget: PublicWidget, visitor: Visitor, input: { text: unknown; nonce: unknown; pageUrl?: unknown; now?: Date }): Promise<{ duplicate: boolean }> {
  const now = input.now ?? new Date();
  if (!widget.enabled) throw new WebchatError("This chat is switched off at the moment.", 409);
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text) throw new WebchatError("Write a message first.", 400);
  if (text.length > WEBCHAT_MAX_TEXT) throw new WebchatError(`Messages can be at most ${WEBCHAT_MAX_TEXT} characters.`, 400);
  if (!isClientNonce(input.nonce)) throw new WebchatError("Bad request.", 400);
  const prefix = `wc:${visitor.id}:`;
  const lastMinute = await platformPrisma.channelInboundEvent.count({ where: { connectionId: widget.connectionId, dedupKey: { startsWith: prefix }, receivedAt: { gte: new Date(now.getTime() - 60_000) } } });
  if (lastMinute >= 12) throw new WebchatError("You are sending messages very quickly. Wait a moment.", 429);

  const payload: WebchatInboundPayload = {
    provider: "WEBCHAT",
    visitorId: visitor.id,
    nonce: input.nonce,
    text,
    name: visitor.name ? (visitor.verified ? visitor.name : `${visitor.name} (unverified)`) : null,
    email: visitor.email,
    occurredAt: now.toISOString(),
    offHours: !widgetAvailability(widget, now).open || undefined,
  };
  const created = await platformPrisma.channelInboundEvent.createMany({
    data: [{ projectId: widget.projectId, connectionId: widget.connectionId, dedupKey: `${prefix}${input.nonce}`, payload: payload as never, receivedAt: now }],
    skipDuplicates: true,
  });
  await touchVisitor(visitor, input.pageUrl, widget);
  return { duplicate: created.count === 0 };
}

async function touchVisitor(visitor: Visitor, pageUrl: unknown, widget: PublicWidget): Promise<void> {
  const page = pageOn(widget, pageUrl);
  await platformPrisma.webChatVisitor.update({ where: { id: visitor.id }, data: { typingAt: null, ...(page ? { pageUrl: page } : {}) } }).catch(() => undefined);
}

/**
 * A photo or PDF from the visitor (WEBSITE_CHAT.md §Files). The type is read from the bytes, the file is
 * stored on the media volume under this project and visitor, and ONE inbound event carries it to the
 * worker like any message. Served afterwards only to the project's own agents, never publicly.
 */
export async function recordVisitorFile(widget: PublicWidget, visitor: Visitor, input: { bytes: Buffer; fileName: string; pageUrl?: unknown; now?: Date }): Promise<{ name: string }> {
  const now = input.now ?? new Date();
  if (!widget.enabled) throw new WebchatError("This chat is switched off at the moment.", 409);
  if (!widget.settings.allowAttachments) throw new WebchatError("Files cannot be sent in this chat.", 403);
  if (input.bytes.length === 0) throw new WebchatError("The file is empty.", 400);
  if (input.bytes.length > WEBCHAT_ATTACHMENT_MAX_BYTES) throw new WebchatError("Files can be at most 10 MB.", 413);
  const plan = planVisitorAttachment({ head: new Uint8Array(input.bytes.subarray(0, 64)), fileName: input.fileName || "file", size: input.bytes.length });
  if (!plan.ok) throw new WebchatError(plan.error, 415);
  const prefix = `wc:${visitor.id}:file-`;
  const lastHour = await platformPrisma.channelInboundEvent.count({ where: { connectionId: widget.connectionId, dedupKey: { startsWith: prefix }, receivedAt: { gte: new Date(now.getTime() - 3_600_000) } } });
  if (lastHour >= WEBCHAT_ATTACHMENTS_PER_HOUR) throw new WebchatError("You have sent a lot of files. Wait a while before sending more.", 429);
  const storage = getMediaStorage();
  if (!storage) throw new WebchatError("Files cannot be received right now.", 503);
  // The media volume is Postgres's disk too: below MEDIA_MIN_FREE_DISK_MB nothing new is written (MEDIA_STORAGE.md).
  const minFreeMb = Number(process.env.MEDIA_MIN_FREE_DISK_MB ?? 2048);
  const free = await storage.freeBytes().catch(() => null);
  if (free !== null && free - input.bytes.length < (Number.isFinite(minFreeMb) && minFreeMb >= 0 ? minFreeMb : 2048) * 1024 * 1024) {
    throw new WebchatError("Files cannot be received right now. You can still send a message.", 507);
  }

  const ext = plan.mimeType === "application/pdf" ? "pdf" : plan.mimeType === "image/png" ? "png" : plan.mimeType === "image/webp" ? "webp" : "jpg";
  const id = randomBytes(18).toString("base64url");
  const storageKey = `webchat/${widget.projectId}/${visitor.id}/${id}.${ext}`;
  await storage.put(storageKey, input.bytes, { maxBytes: WEBCHAT_ATTACHMENT_MAX_BYTES });
  const attachment: WebchatAttachment = { type: plan.type, name: plan.fileName.slice(0, 120), mimeType: plan.mimeType, size: input.bytes.length, storageKey };
  const payload: WebchatInboundPayload = {
    provider: "WEBCHAT",
    visitorId: visitor.id,
    nonce: `file-${id}`,
    text: "",
    name: visitor.name ? (visitor.verified ? visitor.name : `${visitor.name} (unverified)`) : null,
    email: visitor.email,
    occurredAt: now.toISOString(),
    attachments: [attachment],
    offHours: !widgetAvailability(widget, now).open || undefined,
  };
  try {
    await platformPrisma.channelInboundEvent.create({
      data: { projectId: widget.projectId, connectionId: widget.connectionId, dedupKey: `${prefix}${id}`, payload: payload as never, receivedAt: now },
    });
  } catch (err) {
    await storage.delete(storageKey).catch(() => undefined);
    throw err;
  }
  await touchVisitor(visitor, input.pageUrl, widget);
  return { name: attachment.name };
}

/** The visitor is typing. Written at most every 2 seconds. */
export async function markVisitorTyping(visitor: Visitor, now: Date = new Date()): Promise<void> {
  await platformPrisma.webChatVisitor.updateMany({
    where: { id: visitor.id, OR: [{ typingAt: null }, { typingAt: { lt: new Date(now.getTime() - 2_000) } }] },
    data: { typingAt: now },
  });
}

export interface VisitorMessage {
  id: string;
  from: "visitor" | "team" | "ai";
  author: string | null;
  text: string;
  at: string;
  /** The visitor's own nonce, so the widget can swap its optimistic copy for this one. */
  nonce: string | null;
  /** File names only: a visitor's own files are not served back to the browser. */
  files: string[];
  /** The visitor has seen this reply (team / AI messages only). */
  seen: boolean;
}

const AGENT_TYPING_MS = 6_000;

/**
 * The visitor's own conversation, sent messages only, oldest first, plus whether an agent is typing.
 * With `seen` (the widget is open and in view) the team's replies so far are marked READ, which the
 * inbox shows as "Seen". Never another conversation, a note, or a queued or failed reply.
 */
export async function visitorConversation(widget: PublicWidget, visitor: Visitor, after: string | null, seen: boolean, now: Date = new Date()): Promise<{ messages: VisitorMessage[]; agentTyping: boolean }> {
  const conversation = await platformPrisma.channelConversation.findFirst({
    where: { projectId: widget.projectId, connectionId: widget.connectionId, externalThreadId: visitor.id },
    select: { id: true, agentTypingAt: true },
  });
  if (!conversation) return { messages: [], agentTyping: false };
  if (seen) {
    await platformPrisma.channelMessage.updateMany({
      where: { projectId: widget.projectId, conversationId: conversation.id, direction: "OUTBOUND", deliveryStatus: { in: ["SENT", "DELIVERED"] } },
      data: { deliveryStatus: "READ", readAt: now },
    });
  }
  const since = after ? new Date(after) : null;
  const rows = await platformPrisma.channelMessage.findMany({
    where: {
      projectId: widget.projectId,
      conversationId: conversation.id,
      OR: [{ direction: "INBOUND" }, { direction: "OUTBOUND", deliveryStatus: { in: ["SENT", "DELIVERED", "READ"] } }],
      ...(since && !Number.isNaN(since.getTime()) ? { occurredAt: { gt: since } } : {}),
    },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    take: 200,
    select: { id: true, direction: true, senderType: true, text: true, attachments: true, deliveryStatus: true, occurredAt: true, externalMessageId: true, createdBy: { select: { name: true } } },
  });
  const messages = rows
    .map((m) => {
      const files = Array.isArray(m.attachments) ? (m.attachments as Array<{ name?: string }>).map((a) => (typeof a?.name === "string" ? a.name : "file")).slice(0, 5) : [];
      return {
        id: m.id,
        from: (m.direction === "INBOUND" ? "visitor" : m.senderType === "AI" ? "ai" : "team") as VisitorMessage["from"],
        author: m.direction === "INBOUND" ? null : m.senderType === "AI" ? null : (m.createdBy?.name.split(" ")[0] ?? null),
        text: m.text ?? "",
        at: m.occurredAt.toISOString(),
        nonce: m.externalMessageId?.startsWith("wc-") ? m.externalMessageId.slice(3) : null,
        files,
        seen: m.direction === "OUTBOUND" && (seen || m.deliveryStatus === "READ"),
      };
    })
    .filter((m) => m.text || m.files.length);
  const agentTyping = Boolean(conversation.agentTypingAt && now.getTime() - conversation.agentTypingAt.getTime() < AGENT_TYPING_MS);
  return { messages, agentTyping };
}

// ── Settings (project-scoped; the caller checks channels.manage) ─────────────────────────────────

export function widgetScriptUrl(): string | null {
  const origin = publicOrigin();
  return origin ? `${origin}/api/webchat/widget.js` : null;
}

export interface WebchatDetails {
  key: string;
  scriptUrl: string | null;
  settings: WidgetSettings;
  allowedOrigins: string[];
  hasIdentitySecret: boolean;
  stats: { visitors7d: number; conversations: number; messages7d: number };
}

export async function getWebchatDetails(id: string, now: Date = new Date()): Promise<WebchatDetails | null> {
  const row = await prisma.channelConnection.findFirst({ where: { id, type: "WEBCHAT" }, select: { id: true, webhookKey: true, widgetSettings: true, allowedOrigins: true, webhookSecretCiphertext: true } });
  if (!row) return null;
  const week = new Date(now.getTime() - 7 * 86_400_000);
  const [visitors7d, conversations, messages7d] = await Promise.all([
    prisma.webChatVisitor.count({ where: { connectionId: id, createdAt: { gte: week } } }),
    prisma.channelConversation.count({ where: { connectionId: id } }),
    prisma.channelMessage.count({ where: { connectionId: id, occurredAt: { gte: week } } }),
  ]);
  return {
    key: row.webhookKey,
    scriptUrl: widgetScriptUrl(),
    settings: parseWidgetSettings(row.widgetSettings),
    allowedOrigins: row.allowedOrigins,
    hasIdentitySecret: Boolean(row.webhookSecretCiphertext),
    stats: { visitors7d, conversations, messages7d },
  };
}

/** Creates a website chat widget: no provider to check, so it is CONNECTED at once. */
export async function connectWebchat(input: { name: string; origins: string[]; username: string; now?: Date }): Promise<{ id: string }> {
  const now = input.now ?? new Date();
  const created = await prisma.channelConnection.create({
    data: {
      type: "WEBCHAT",
      name: input.name,
      status: "CONNECTED",
      enabled: true,
      externalAccountName: "Website",
      webhookKey: randomBytes(24).toString("base64url"),
      allowedOrigins: input.origins,
      widgetSettings: parseWidgetSettings({}) as never,
      lastCheckedAt: now,
      credentialsUpdatedAt: now,
      credentialsUpdatedByUsername: input.username,
      createdByUsername: input.username,
    },
    select: { id: true },
  });
  return created;
}

export async function saveWebchatSettings(id: string, input: { settings: unknown; origins: string[] }): Promise<void> {
  const updated = await prisma.channelConnection.updateMany({
    where: { id, type: "WEBCHAT" },
    data: { widgetSettings: parseWidgetSettings(input.settings) as never, allowedOrigins: input.origins },
  });
  if (updated.count === 0) throw new WebchatError("That widget no longer exists.", 404);
}

/** A new identity secret, returned ONCE; it replaces the old one (sites must update their signing). */
export async function rotateWebchatIdentitySecret(id: string): Promise<string> {
  const secret = randomBytes(32).toString("hex");
  const updated = await prisma.channelConnection.updateMany({ where: { id, type: "WEBCHAT" }, data: { webhookSecretCiphertext: encryptSecret(secret) } });
  if (updated.count === 0) throw new WebchatError("That widget no longer exists.", 404);
  return secret;
}
