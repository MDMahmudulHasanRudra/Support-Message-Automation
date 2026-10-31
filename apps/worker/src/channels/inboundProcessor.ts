import { decryptSecret } from "@support-automation/db";
import {
  advanceDeliveryStatus,
  channelMessagePreview,
  normalizeMetaEvent,
  normalizeTelegramUpdate,
  normalizeWebchatEvent,
  type ChannelDeliveryStatus,
  type NormalizedChannelEvent,
} from "@support-automation/shared";
import type { ChannelInboundEvent, Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { recordLoopTick, registerLoop } from "../health/loopLiveness.js";
import { forEachProject } from "../project/context.js";
import { projectHasFeature } from "../project/features.js";
import { getAiSettings } from "../ai/settings.js";
import { metaAppSecretFor, fetchMetaProfileName, type FetchImpl } from "./providerApi.js";

/**
 * Turns recorded webhook events into conversations and messages (OMNICHANNEL.md §7).
 *
 * The web app records every event the moment a provider sends it (`ChannelInboundEvent`); this loop
 * reads them per project, oldest first, and for each:
 *   - a customer's message → finds or opens the conversation and stores the message;
 *   - an echo (something the business account sent) → recognises our own send by the metadata we
 *     attached or the id the provider returned, and otherwise stores it as sent from the provider's
 *     own app — and, because a person is then handling the conversation, pauses AI there;
 *   - a delivery / read receipt → moves our sent messages forward, never back;
 *   - anything else → recorded as IGNORED with the reason.
 *
 * Idempotent end to end: the message's provider id is unique per connection, so a replayed event
 * finds the row it already wrote and stops — it cannot store a message twice or ask AI twice.
 * A project whose Omnichannel feature is off is skipped entirely: its events stay PENDING and are
 * processed when it is switched back on (AI answers nothing older than its window, so a backlog
 * never turns into a burst of replies).
 *
 * AI does not run here: `aiReply.ts` picks up new customer messages on its own loop, so a slow
 * completion never holds up message storage.
 */

const LOOP_NAME = "channel-inbound";
const EVENTS_PER_TICK = 50;
const MAX_ATTEMPTS = 5;
/** Processed / ignored / failed events are kept this long for diagnosis, then deleted (they hold message text). */
export const EVENT_RETENTION_MS = 14 * 24 * 60 * 60_000;
const PRUNE_EVERY_MS = 60 * 60_000;
const lastPrune = new Map<string, number>();

export function startChannelInboundProcessor(intervalMs = 2_000): NodeJS.Timeout {
  registerLoop(LOOP_NAME, intervalMs);
  let processing = false;
  return setInterval(() => {
    if (processing) return;
    processing = true;
    void runChannelInboundTick()
      .catch((err) => console.error("[channels] unexpected error processing webhook events", err))
      .finally(() => {
        processing = false;
        recordLoopTick(LOOP_NAME, intervalMs);
      });
  }, intervalMs);
}

/** One pass over every operating project with the feature on. Exported for tests. */
export async function runChannelInboundTick(now: Date = new Date(), fetchImpl: FetchImpl = fetch): Promise<void> {
  await forEachProject(LOOP_NAME, async (projectId) => {
    if (!(await projectHasFeature("OMNICHANNEL"))) return;
    const events = await prisma.channelInboundEvent.findMany({
      where: { status: "PENDING", attempts: { lt: MAX_ATTEMPTS } },
      orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
      take: EVENTS_PER_TICK,
    });
    for (const event of events) await processChannelEvent(event, now, fetchImpl);
    await pruneOldEvents(projectId, now);
  });
}

async function pruneOldEvents(projectId: string, now: Date): Promise<void> {
  const last = lastPrune.get(projectId) ?? 0;
  if (now.getTime() - last < PRUNE_EVERY_MS) return;
  lastPrune.set(projectId, now.getTime());
  await prisma.channelInboundEvent.deleteMany({
    where: { status: { in: ["PROCESSED", "IGNORED", "FAILED"] }, receivedAt: { lt: new Date(now.getTime() - EVENT_RETENTION_MS) } },
  });
}

export function resetChannelInboundStateForTests(): void {
  lastPrune.clear();
}

type Connection = {
  id: string;
  type: "MESSENGER" | "INSTAGRAM" | "TELEGRAM" | "WEBCHAT";
  externalAccountId: string | null;
  appId: string | null;
  authMode: "MANUAL" | "PLATFORM";
  accessTokenCiphertext: string | null;
  appSecretCiphertext: string | null;
};

/** Process one recorded event. Never throws: a failure is counted on the row and retried, at most MAX_ATTEMPTS times. */
export async function processChannelEvent(event: ChannelInboundEvent, now: Date = new Date(), fetchImpl: FetchImpl = fetch): Promise<void> {
  try {
    const connection = await prisma.channelConnection.findUnique({
      where: { id: event.connectionId },
      select: { id: true, type: true, externalAccountId: true, appId: true, authMode: true, accessTokenCiphertext: true, appSecretCiphertext: true },
    });
    if (!connection) return settle(event.id, "IGNORED", "The connection no longer exists.");
    const payload = event.payload as { provider?: string; item?: unknown; update?: unknown };
    let normalized: NormalizedChannelEvent;
    if (payload.provider === "TELEGRAM") normalized = normalizeTelegramUpdate(payload.update, event.receivedAt);
    // Website chat: the web already validated the visitor and recorded a plain message (WEBSITE_CHAT.md).
    else if (payload.provider === "WEBCHAT") normalized = connection.type === "WEBCHAT" ? normalizeWebchatEvent(payload) : { type: "IGNORED", reason: "Not a website chat connection." };
    else if (connection.externalAccountId) normalized = normalizeMetaEvent(payload.item, connection.externalAccountId, event.receivedAt);
    else normalized = { type: "IGNORED", reason: "The connection has no account id yet." };

    switch (normalized.type) {
      case "IGNORED":
        return settle(event.id, "IGNORED", normalized.reason);
      case "MESSAGE":
        await storeMessage(connection, normalized, now, fetchImpl);
        return settle(event.id, "PROCESSED", null);
      case "DELIVERY":
        await applyReceipt(connection.id, normalized.threadId, "DELIVERED", { mids: normalized.externalMessageIds, watermark: normalized.watermark }, now);
        return settle(event.id, "PROCESSED", null);
      case "READ":
        await applyReceipt(connection.id, normalized.threadId, "READ", { mid: normalized.externalMessageId, watermark: normalized.watermark }, now);
        return settle(event.id, "PROCESSED", null);
    }
  } catch (err) {
    const attempts = event.attempts + 1;
    const message = (err as Error)?.message?.slice(0, 500) ?? String(err);
    console.error(`[channels] event ${event.id} failed (attempt ${attempts})`, err);
    await prisma.channelInboundEvent.update({
      where: { id: event.id },
      data: { attempts, lastError: message, ...(attempts >= MAX_ATTEMPTS ? { status: "FAILED", processedAt: now } : {}) },
    });
  }
}

async function settle(id: string, status: "PROCESSED" | "IGNORED", note: string | null): Promise<void> {
  await prisma.channelInboundEvent.update({ where: { id }, data: { status, note, processedAt: new Date(), lastError: null } });
}

const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === "P2002";

async function storeMessage(connection: Connection, event: Extract<NormalizedChannelEvent, { type: "MESSAGE" }>, now: Date, fetchImpl: FetchImpl): Promise<void> {
  const conversation = await findOrOpenConversation(connection, event, fetchImpl);

  if (event.direction === "OUTBOUND") {
    await storeEcho(connection, conversation.id, event, now);
    return;
  }

  // A customer's message. The unique provider id is the idempotency guard: a replayed event lands
  // here, fails the insert, and stops — so it never reaches AI a second time either.
  try {
    await prisma.channelMessage.create({
      data: {
        conversationId: conversation.id,
        connectionId: connection.id,
        type: connection.type,
        direction: "INBOUND",
        senderType: "CUSTOMER",
        senderExternalId: event.senderExternalId,
        senderName: event.senderName,
        externalMessageId: event.externalMessageId,
        text: event.text,
        contentType: event.contentType,
        attachments: event.attachments.length ? (event.attachments as unknown as Prisma.InputJsonValue) : undefined,
        replyToExternalId: event.replyToExternalId,
        occurredAt: event.occurredAt,
        // A bot is never answered by AI — recorded as decided, so the AI loop never looks at it.
        ...(event.senderIsBot ? { aiClaimedAt: now, aiOutcome: "SKIPPED" as const, aiReason: "Sent by a bot." } : {}),
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) return;
    throw err;
  }
  await touchConversation(conversation.id, conversation.lastMessageAt, {
    at: event.occurredAt,
    preview: channelMessagePreview(event.text, event.contentType),
    direction: "INBOUND",
    inbound: true,
  });
}

async function findOrOpenConversation(connection: Connection, event: Extract<NormalizedChannelEvent, { type: "MESSAGE" }>, fetchImpl: FetchImpl) {
  const existing = await prisma.channelConversation.findFirst({
    where: { connectionId: connection.id, externalThreadId: event.threadId },
    select: { id: true, lastMessageAt: true, customerName: true, title: true },
  });
  const inbound = event.direction === "INBOUND";
  if (existing) {
    // Telegram tells us the sender's current name on every message; keep it current for a 1:1 chat.
    if (inbound && event.threadKind === "DIRECT" && event.senderName && event.senderName !== existing.customerName) {
      await prisma.channelConversation.update({ where: { id: existing.id }, data: { customerName: event.senderName, customerUsername: event.senderUsername, title: event.threadTitle ?? existing.title } });
    }
    return existing;
  }

  let customerName = inbound && event.threadKind === "DIRECT" ? event.senderName : null;
  let customerUsername = inbound ? event.senderUsername : null;
  if (!customerName && (connection.type === "MESSENGER" || connection.type === "INSTAGRAM") && connection.accessTokenCiphertext) {
    try {
      const appSecret = metaAppSecretFor(connection);
      if (!appSecret) throw new Error("no app secret");
      const profile = await fetchMetaProfileName({
        type: connection.type,
        userId: event.threadId,
        token: decryptSecret(connection.accessTokenCiphertext),
        appSecret,
        fetchImpl,
      });
      customerName = profile.name;
      customerUsername = profile.username;
    } catch {
      /* best effort: the conversation is shown by id */
    }
  }
  try {
    return await prisma.channelConversation.create({
      data: {
        connectionId: connection.id,
        type: connection.type,
        externalThreadId: event.threadId,
        kind: event.threadKind,
        title: event.threadKind === "GROUP" ? event.threadTitle : (customerName ?? event.threadTitle),
        customerExternalId: event.threadKind === "DIRECT" ? event.threadId : null,
        customerName,
        customerUsername,
      },
      select: { id: true, lastMessageAt: true, customerName: true, title: true },
    });
  } catch (err) {
    // Two events for a brand-new conversation processed together: the other one opened it.
    if (!isUniqueViolation(err)) throw err;
    return prisma.channelConversation.findFirstOrThrow({
      where: { connectionId: connection.id, externalThreadId: event.threadId },
      select: { id: true, lastMessageAt: true, customerName: true, title: true },
    });
  }
}

/**
 * Something the business account sent. Three cases, in order:
 *   1. our own send, recognised by the metadata we attached (Messenger) — or by the provider id we
 *      already stored — so it is not stored twice;
 *   2. our own send whose echo outran the send's own response (Instagram has no metadata): the row we
 *      are still SENDING in this conversation with the same text takes the id;
 *   3. a person replying from Meta Business Suite / the Page inbox: stored as BUSINESS, and AI is
 *      paused in the conversation, because a human is now handling it.
 */
async function storeEcho(connection: Connection, conversationId: string, event: Extract<NormalizedChannelEvent, { type: "MESSAGE" }>, now: Date): Promise<void> {
  const byId = await prisma.channelMessage.findFirst({ where: { connectionId: connection.id, externalMessageId: event.externalMessageId }, select: { id: true } });
  if (byId) return;

  if (event.metadata) {
    const ours = await prisma.channelMessage.findFirst({ where: { id: event.metadata, conversationId, direction: "OUTBOUND" }, select: { id: true, externalMessageId: true } });
    if (ours) {
      if (!ours.externalMessageId) await attachProviderId(ours.id, event.externalMessageId);
      return;
    }
  }

  const inFlight = await prisma.channelMessage.findFirst({
    where: {
      conversationId,
      direction: "OUTBOUND",
      externalMessageId: null,
      deliveryStatus: { in: ["SENDING", "UNKNOWN"] },
      text: event.text,
      createdAt: { gte: new Date(now.getTime() - 10 * 60_000) },
    },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (inFlight) {
    await attachProviderId(inFlight.id, event.externalMessageId);
    return;
  }

  try {
    await prisma.channelMessage.create({
      data: {
        conversationId,
        connectionId: connection.id,
        type: connection.type,
        direction: "OUTBOUND",
        senderType: "BUSINESS",
        senderExternalId: event.senderExternalId,
        externalMessageId: event.externalMessageId,
        text: event.text,
        contentType: event.contentType,
        attachments: event.attachments.length ? (event.attachments as unknown as Prisma.InputJsonValue) : undefined,
        occurredAt: event.occurredAt,
        deliveryStatus: "SENT",
        sentAt: event.occurredAt,
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) return;
    throw err;
  }
  const current = await prisma.channelConversation.findUniqueOrThrow({ where: { id: conversationId }, select: { lastMessageAt: true } });
  await touchConversation(conversationId, current.lastMessageAt, { at: event.occurredAt, preview: channelMessagePreview(event.text, event.contentType), direction: "OUTBOUND", inbound: false });

  // The same human-takeover rule WhatsApp uses: a person answered, so AI stays out of it for a while.
  const ai = await getAiSettings();
  const until = new Date(now.getTime() + ai.humanTakeoverCooldownMinutes * 60_000);
  await prisma.channelConversation.updateMany({
    where: { id: conversationId, OR: [{ aiSuppressedUntil: null }, { aiSuppressedUntil: { lt: until } }] },
    data: { aiSuppressedUntil: until },
  });
}

/** Give our outbound row the provider's id. If the echo got there first as a separate row, that row is the same message and goes. */
async function attachProviderId(messageId: string, externalMessageId: string): Promise<void> {
  try {
    await prisma.channelMessage.update({ where: { id: messageId }, data: { externalMessageId } });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
}

/**
 * Move the conversation's "latest" fields forward. Only ever forward: a provider can deliver events
 * out of order, and an older message arriving late must not replace the preview of a newer one. A
 * customer's message also reopens a closed conversation — they are talking again.
 */
async function touchConversation(
  conversationId: string,
  lastMessageAt: Date | null,
  input: { at: Date; preview: string; direction: "INBOUND" | "OUTBOUND"; inbound: boolean },
): Promise<void> {
  const newest = !lastMessageAt || input.at >= lastMessageAt;
  const data: Prisma.ChannelConversationUpdateInput = {};
  if (newest) {
    data.lastMessageAt = input.at;
    data.lastMessagePreview = input.preview;
    data.lastMessageDirection = input.direction;
  }
  if (input.inbound) {
    data.status = "OPEN";
    data.closedAt = null;
  }
  if (Object.keys(data).length) await prisma.channelConversation.update({ where: { id: conversationId }, data });
  if (input.inbound) {
    await prisma.channelConversation.updateMany({
      where: { id: conversationId, OR: [{ lastInboundAt: null }, { lastInboundAt: { lt: input.at } }] },
      data: { lastInboundAt: input.at },
    });
  }
}

/**
 * Delivery and read receipts: our sent messages to this customer move to DELIVERED / READ — only
 * forward (packages/shared `advanceDeliveryStatus`). Meta identifies them by id (Messenger delivery)
 * or by a watermark meaning "everything sent up to this moment".
 */
async function applyReceipt(
  connectionId: string,
  threadId: string,
  receipt: "DELIVERED" | "READ",
  by: { mids?: string[]; mid?: string | null; watermark: Date | null },
  now: Date,
): Promise<void> {
  const conversation = await prisma.channelConversation.findFirst({ where: { connectionId, externalThreadId: threadId }, select: { id: true } });
  if (!conversation) return;
  const or: Prisma.ChannelMessageWhereInput[] = [];
  if (by.mids?.length) or.push({ externalMessageId: { in: by.mids } });
  if (by.watermark) or.push({ sentAt: { lte: by.watermark } });
  if (by.mid) {
    const anchor = await prisma.channelMessage.findFirst({ where: { connectionId, externalMessageId: by.mid }, select: { occurredAt: true } });
    or.push({ externalMessageId: by.mid });
    if (anchor) or.push({ occurredAt: { lte: anchor.occurredAt } });
  }
  if (or.length === 0) return;
  const candidates = await prisma.channelMessage.findMany({
    where: { conversationId: conversation.id, direction: "OUTBOUND", deliveryStatus: { in: ["SENT", "DELIVERED", "UNKNOWN"] }, OR: or },
    select: { id: true, deliveryStatus: true },
  });
  for (const row of candidates) {
    const next = advanceDeliveryStatus(row.deliveryStatus as ChannelDeliveryStatus, receipt);
    if (next === row.deliveryStatus) continue;
    await prisma.channelMessage.updateMany({
      where: { id: row.id, deliveryStatus: row.deliveryStatus },
      data: { deliveryStatus: next, ...(next === "READ" ? { readAt: now } : { deliveredAt: now }), ...(row.deliveryStatus === "UNKNOWN" ? { lastError: null } : {}) },
    });
  }
}
