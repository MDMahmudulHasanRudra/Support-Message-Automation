import type { ChannelAttachment, ChannelContentType, NormalizedChannelEvent, SplitWebhookEvent } from "./channels.js";

/**
 * WhatsApp (Official API), the Cloud API (WHATSAPP_OFFICIAL.md, feature WHATSAPP_OFFICIAL). A channel beside the others, separate from the
 * linked-device "WhatsApp (Legacy)" module: nothing here reads or writes `Message`, `WhatsAppAccount` or `OutboundMessage`. Written from
 * Meta's published webhook and send formats and tested against simulated payloads.
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : typeof v === "number" ? String(v) : null);

function timeOf(value: unknown, fallback: Date): Date {
  const n = Number(str(value));
  return Number.isFinite(n) && n > 0 ? new Date(n < 1e12 ? n * 1000 : n) : fallback;
}

/**
 * A webhook body cut into one event per message and per status change. `accountId` is the phone number id, the one thing that says which
 * connection an event belongs to. A status is keyed with its value, because one message legitimately reports sent, delivered and read.
 */
export function splitWhatsAppCloudWebhook(body: unknown, receivedAt: Date): SplitWebhookEvent[] {
  if (!isObj(body) || body.object !== "whatsapp_business_account" || !Array.isArray(body.entry)) return [];
  const out: SplitWebhookEvent[] = [];
  for (const entry of body.entry) {
    if (!isObj(entry) || !Array.isArray(entry.changes)) continue;
    for (const change of entry.changes) {
      if (!isObj(change) || change.field !== "messages" || !isObj(change.value)) continue;
      const value = change.value;
      const accountId = isObj(value.metadata) ? str(value.metadata.phone_number_id) : null;
      if (!accountId) continue;
      const contacts = Array.isArray(value.contacts) ? value.contacts.filter(isObj) : [];
      for (const message of Array.isArray(value.messages) ? value.messages : []) {
        if (!isObj(message)) continue;
        const id = str(message.id);
        if (!id) continue;
        const contact = contacts.find((c) => str(c.wa_id) === str(message.from)) ?? contacts[0] ?? null;
        out.push({ accountId, dedupKey: `m:${id}`, occurredAt: timeOf(message.timestamp, receivedAt), item: { kind: "message", message, contact } });
      }
      for (const status of Array.isArray(value.statuses) ? value.statuses : []) {
        if (!isObj(status)) continue;
        const id = str(status.id);
        const state = str(status.status);
        if (!id || !state) continue;
        out.push({ accountId, dedupKey: `s:${id}:${state}`, occurredAt: timeOf(status.timestamp, receivedAt), item: { kind: "status", status } });
      }
    }
  }
  return out;
}

const MEDIA: Record<string, ChannelContentType> = { image: "IMAGE", video: "VIDEO", audio: "AUDIO", voice: "AUDIO", document: "FILE", sticker: "STICKER" };

export function normalizeWhatsAppCloudEvent(item: unknown, receivedAt: Date): NormalizedChannelEvent {
  if (!isObj(item)) return { type: "IGNORED", reason: "Not a WhatsApp event." };

  if (item.kind === "status") {
    const status = isObj(item.status) ? item.status : {};
    const id = str(status.id);
    const thread = str(status.recipient_id) ?? "";
    const at = timeOf(status.timestamp, receivedAt);
    switch (str(status.status)) {
      case "delivered":
        return id ? { type: "DELIVERY", threadId: thread, externalMessageIds: [id], watermark: at } : { type: "IGNORED", reason: "A status with no message." };
      case "read":
        return { type: "READ", threadId: thread, watermark: at, externalMessageId: id };
      case "failed": {
        const first = Array.isArray(status.errors) && isObj(status.errors[0]) ? status.errors[0] : {};
        return id ? { type: "SEND_FAILED", externalMessageId: id, reason: `WhatsApp could not deliver this: ${str(first.title) ?? str(first.message) ?? "no reason given"}.` } : { type: "IGNORED", reason: "A failure with no message." };
      }
      default:
        return { type: "IGNORED", reason: "Sent is recorded when the send is accepted." };
    }
  }

  if (item.kind !== "message" || !isObj(item.message)) return { type: "IGNORED", reason: "Not a WhatsApp event." };
  const m = item.message;
  const from = str(m.from);
  const id = str(m.id);
  if (!from || !id) return { type: "IGNORED", reason: "A message with no sender." };
  const kind = str(m.type) ?? "";
  const contact = isObj(item.contact) ? item.contact : null;
  const profile = contact && isObj(contact.profile) ? str(contact.profile.name) : null;

  let text: string | null = null;
  let contentType: ChannelContentType = "TEXT";
  const attachments: ChannelAttachment[] = [];
  if (kind === "text" && isObj(m.text)) text = str(m.text.body);
  else if (kind === "button" && isObj(m.button)) text = str(m.button.text);
  else if (kind === "interactive" && isObj(m.interactive)) {
    const reply = isObj(m.interactive.button_reply) ? m.interactive.button_reply : isObj(m.interactive.list_reply) ? m.interactive.list_reply : null;
    text = reply ? str(reply.title) : null;
  } else if (kind in MEDIA) {
    contentType = MEDIA[kind]!;
    const media = isObj(m[kind]) ? (m[kind] as Obj) : {};
    text = str(media.caption);
    attachments.push({ type: contentType, name: str(media.filename) ?? undefined } as ChannelAttachment);
  } else if (kind === "location") contentType = "LOCATION";
  else if (kind === "contacts") contentType = "CONTACT";
  else contentType = "UNSUPPORTED";

  return {
    type: "MESSAGE",
    direction: "INBOUND",
    externalMessageId: id,
    threadId: from,
    threadKind: "DIRECT",
    threadTitle: null,
    senderExternalId: from,
    senderName: profile,
    senderUsername: from,
    senderIsBot: false,
    occurredAt: timeOf(m.timestamp, receivedAt),
    text,
    contentType,
    attachments,
    appId: null,
    metadata: null,
    replyToExternalId: isObj(m.context) ? str(m.context.id) : null,
  };
}

// ── Templates ───────────────────────────────────────────────────────────────────────────────────

export interface CloudTemplateReading {
  name: string;
  language: string;
  category: string;
  status: string;
  bodyText: string;
  paramCount: number;
  /** Header media or buttons needing values: not sendable from here. */
  supported: boolean;
}

/** One template from Meta's list. Only plain-text bodies with numbered blanks can be sent from here. */
export function readCloudTemplate(raw: unknown): CloudTemplateReading | null {
  if (!isObj(raw)) return null;
  const name = str(raw.name);
  const language = str(raw.language);
  if (!name || !language) return null;
  const components = Array.isArray(raw.components) ? raw.components.filter(isObj) : [];
  const body = components.find((c) => c.type === "BODY");
  const bodyText = (body && str(body.text)) ?? "";
  const named = /\{\{[a-zA-Z_]/.test(bodyText);
  const numbers = [...bodyText.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
  const header = components.find((c) => c.type === "HEADER");
  const buttons = components.find((c) => c.type === "BUTTONS");
  const dynamicButton = buttons && Array.isArray(buttons.buttons) && buttons.buttons.filter(isObj).some((b) => b.type === "URL" && /\{\{/.test(str(b.url) ?? ""));
  const supported = Boolean(bodyText) && !named && !dynamicButton && (!header || header.format === "TEXT") && !/\{\{/.test(header ? (str(header.text) ?? "") : "");
  return { name, language, category: str(raw.category) ?? "", status: str(raw.status) ?? "", bodyText, paramCount: numbers.length ? Math.max(...numbers) : 0, supported };
}

export function renderCloudTemplate(bodyText: string, params: readonly string[]): string {
  return bodyText.replace(/\{\{(\d+)\}\}/g, (whole, n: string) => params[Number(n) - 1] ?? whole);
}
