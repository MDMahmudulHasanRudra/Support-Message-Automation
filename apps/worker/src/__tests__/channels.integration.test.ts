import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { createProjectWithDefaults, encryptSecret, prisma as rawPrisma } from "@support-automation/db";
import type { ChannelInboundEvent } from "@prisma/client";
import { withProject, resetProjectCachesForTests } from "../project/context.js";
import { resetProjectFeatureCacheForTests } from "../project/features.js";
import { processChannelEvent, runChannelInboundTick } from "../channels/inboundProcessor.js";
import { sendNextQueued, STUCK_SENDING_MS } from "../channels/outboundProcessor.js";
import { AI_SETTLE_MS, answerChannelMessage } from "../channels/aiReply.js";
import { MockAiClient } from "./mockAiClient.js";

/**
 * The worker's half of Messenger / Instagram / Telegram (OMNICHANNEL.md): turning recorded webhook
 * events into conversations, the send queue, and AI replies — against a fake Meta and Telegram, in a
 * project of its own.
 *
 * What must hold:
 *   - a replayed event never stores a message twice, and an older event never overwrites a newer preview;
 *   - the echo of our own send is recognised (metadata, or the id the send returned) and never stored
 *     twice; a person replying from Meta's own app is stored as such and pauses AI;
 *   - receipts move a message forward only;
 *   - a send is claimed once; a temporary refusal is retried with backoff, a dead credential marks the
 *     connection, an unknowable outcome is never retried by itself, the window is re-checked at send
 *     time, and an AI reply is dropped if the kill switch was pressed meanwhile;
 *   - AI answers once, in a 1:1 conversation only, never while a person is handling it, never a bot,
 *     only the customer's latest message, and only through the same knowledge gates as WhatsApp.
 */

process.env.AI_CREDENTIALS_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const APP_SECRET = "0123456789abcdef0123456789abcdef";
const PAGE_ID = `page${tag}`;
const PAGE_TOKEN = `EAAPAGE${tag}token0000000000`;
const BOT_TOKEN = `7000${tag.replace(/\D/g, "1")}:AAH${tag}abcdefghijklmnopqrstuvwxyz`;

let projectId = "";
let creatorId = "";
const conn = { messenger: "", instagram: "", telegram: "" };

// ── A fake Meta and Telegram, recording every send ────────────────────────────────────────────────
const fake = {
  sends: [] as Array<{ url: string; body: Record<string, unknown> }>,
  next: [] as Array<"ok" | "rate" | "token" | "timeout" | "window">,
  mid: 0,
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const fakeFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.pathname.endsWith("/messages") || url.pathname.endsWith("/sendMessage")) {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    fake.sends.push({ url: url.origin + url.pathname, body });
    const mode = fake.next.shift() ?? "ok";
    if (mode === "timeout") throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    const telegram = url.hostname === "api.telegram.org";
    if (mode === "rate") return telegram ? json({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 30 } }, 429) : json({ error: { code: 613, message: "rate" } }, 400);
    if (mode === "token") return telegram ? json({ ok: false, error_code: 401, description: "Unauthorized" }, 401) : json({ error: { code: 190, message: "expired" } }, 400);
    if (mode === "window") return json({ error: { code: 10, error_subcode: 2018278, message: "outside window" } }, 400);
    fake.mid++;
    return telegram ? json({ ok: true, result: { message_id: fake.mid, chat: { id: body.chat_id } } }) : json({ recipient_id: (body.recipient as { id: string }).id, message_id: `m.sent.${tag}.${fake.mid}` });
  }
  // Profile lookups.
  if (url.searchParams.get("fields")?.includes("first_name")) return json({ first_name: "Rahim", last_name: "Uddin" });
  if (url.searchParams.get("fields")?.includes("username")) return json({ name: "Nusrat", username: `nusrat_${tag}` });
  return json({ error: { code: 803 } }, 404);
}) as typeof fetch;

// ── Helpers ───────────────────────────────────────────────────────────────────────────────────────
let eventN = 0;
async function event(connectionId: string, payload: unknown, dedupKey = `k-${tag}-${eventN++}`): Promise<ChannelInboundEvent> {
  return rawPrisma.channelInboundEvent.create({ data: { projectId, connectionId, dedupKey, payload: payload as object } });
}
const metaEvent = (item: unknown, type: "MESSENGER" | "INSTAGRAM" = "MESSENGER") => ({ provider: "META", type, accountId: PAGE_ID, item });
const inbound = (user: string, mid: string, text: string, at = Date.now()) => ({ sender: { id: user }, recipient: { id: PAGE_ID }, timestamp: at, message: { mid, text } });
const run = <T,>(fn: () => Promise<T>) => withProject(projectId, fn);
const process_ = async (e: ChannelInboundEvent) => run(() => processChannelEvent(e, new Date(), fakeFetch));
const conversationOf = (connectionId: string, thread: string) => rawPrisma.channelConversation.findFirstOrThrow({ where: { connectionId, externalThreadId: thread } });

async function queue(conversationId: string, connectionId: string, type: "MESSENGER" | "INSTAGRAM" | "TELEGRAM", extra: Record<string, unknown> = {}) {
  return rawPrisma.channelMessage.create({
    data: {
      projectId,
      conversationId,
      connectionId,
      type,
      direction: "OUTBOUND",
      senderType: "AGENT",
      text: "We are on it",
      occurredAt: new Date(),
      deliveryStatus: "QUEUED",
      idempotencyKey: `t-${randomUUID()}`,
      ...extra,
    },
  });
}

beforeAll(async () => {
  creatorId = (await rawPrisma.user.create({ data: { username: `omniw_${tag}`, name: "Omni worker", passwordHash: "x" } })).id;
  const p = await createProjectWithDefaults({ name: `Omni worker ${tag}`, slug: `omni-w-${tag}`, status: "ACTIVE", creatorUserId: creatorId }, rawPrisma);
  projectId = p.id;
  await rawPrisma.projectFeature.update({ where: { projectId_key: { projectId, key: "OMNICHANNEL" } }, data: { enabled: true } });
  const common = { projectId, status: "CONNECTED" as const, appSecretCiphertext: encryptSecret(APP_SECRET), appId: "123456789012" };
  conn.messenger = (await rawPrisma.channelConnection.create({ data: { ...common, type: "MESSENGER", name: "Page", webhookKey: `wkm${tag}${tag}${tag}`, externalAccountId: PAGE_ID, pageId: PAGE_ID, accessTokenCiphertext: encryptSecret(PAGE_TOKEN) } })).id;
  conn.instagram = (await rawPrisma.channelConnection.create({ data: { ...common, type: "INSTAGRAM", name: "@ig", webhookKey: `wki${tag}${tag}${tag}`, externalAccountId: PAGE_ID, pageId: PAGE_ID, accessTokenCiphertext: encryptSecret(PAGE_TOKEN) } })).id;
  conn.telegram = (await rawPrisma.channelConnection.create({ data: { projectId, status: "CONNECTED", type: "TELEGRAM", name: "@bot", webhookKey: `wkt${tag}${tag}${tag}`, externalAccountId: "7000", accessTokenCiphertext: encryptSecret(BOT_TOKEN) } })).id;
  resetProjectCachesForTests();
  resetProjectFeatureCacheForTests();
});

beforeEach(() => {
  fake.sends.length = 0;
  fake.next.length = 0;
});

afterAll(async () => {
  const where = { projectId };
  await rawPrisma.channelMessage.deleteMany({ where });
  await rawPrisma.channelInboundEvent.deleteMany({ where });
  await rawPrisma.channelConversation.deleteMany({ where });
  await rawPrisma.channelConnection.deleteMany({ where });
  await rawPrisma.aiKnowledgeItem.deleteMany({ where });
  await rawPrisma.notification.deleteMany({ where });
  await rawPrisma.systemLog.deleteMany({ where });
  await rawPrisma.projectFeature.deleteMany({ where });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: creatorId } });
});

describe("1. events become conversations", () => {
  it("a customer's message opens a conversation, named from Meta, and is stored once however often it is replayed", async () => {
    const at = Date.now() - 60_000;
    const first = await event(conn.messenger, metaEvent(inbound("U1", `m.1.${tag}`, "Internet is down", at)));
    const replay = await event(conn.messenger, metaEvent(inbound("U1", `m.1.${tag}`, "Internet is down", at)));
    await process_(first);
    await process_(replay);
    const c = await conversationOf(conn.messenger, "U1");
    expect(c).toMatchObject({ customerName: "Rahim Uddin", title: "Rahim Uddin", lastMessagePreview: "Internet is down", lastMessageDirection: "INBOUND", status: "OPEN" });
    expect(c.lastInboundAt?.getTime()).toBe(at);
    expect(await rawPrisma.channelMessage.count({ where: { conversationId: c.id } })).toBe(1);
    expect(await rawPrisma.channelInboundEvent.findMany({ where: { id: { in: [first.id, replay.id] } }, select: { status: true } })).toEqual([{ status: "PROCESSED" }, { status: "PROCESSED" }]);
  });

  it("an older message arriving late never replaces a newer preview, and a customer's message reopens a closed conversation", async () => {
    const c = await conversationOf(conn.messenger, "U1");
    await rawPrisma.channelConversation.update({ where: { id: c.id }, data: { status: "CLOSED", closedAt: new Date() } });
    await process_(await event(conn.messenger, metaEvent(inbound("U1", `m.0.${tag}`, "earlier line", Date.now() - 10 * 60_000))));
    const after = await conversationOf(conn.messenger, "U1");
    expect(after.lastMessagePreview).toBe("Internet is down");
    expect(after.status).toBe("OPEN");
  });

  it("ignores what the inbox does not use, saying why", async () => {
    const e = await event(conn.messenger, metaEvent({ sender: { id: "U1" }, recipient: { id: PAGE_ID }, timestamp: Date.now(), reaction: { reaction: "love", mid: "x" } }));
    await process_(e);
    expect(await rawPrisma.channelInboundEvent.findUniqueOrThrow({ where: { id: e.id } })).toMatchObject({ status: "IGNORED", note: "a reaction" });
  });

  it("Telegram: a private chat and a group, and a bot's message is never given to AI", async () => {
    await process_(await event(conn.telegram, { provider: "TELEGRAM", update: { update_id: 1, message: { message_id: 5, date: Math.floor(Date.now() / 1000), chat: { id: 4242, type: "private", first_name: "Nusrat" }, from: { id: 4242, is_bot: false, first_name: "Nusrat" }, text: "bill?" } } }));
    await process_(await event(conn.telegram, { provider: "TELEGRAM", update: { update_id: 2, message: { message_id: 9, date: Math.floor(Date.now() / 1000), chat: { id: -100, type: "group", title: "Branch" }, from: { id: 7, is_bot: true, first_name: "Alert bot" }, text: "alarm" } } }));
    expect(await conversationOf(conn.telegram, "4242")).toMatchObject({ kind: "DIRECT", title: "Nusrat", customerName: "Nusrat" });
    const group = await conversationOf(conn.telegram, "-100");
    expect(group).toMatchObject({ kind: "GROUP", title: "Branch" });
    expect(await rawPrisma.channelMessage.findFirstOrThrow({ where: { conversationId: group.id } })).toMatchObject({ aiOutcome: "SKIPPED", aiReason: "Sent by a bot." });
  });

  it("a project with the feature off is skipped: its events wait, unprocessed", async () => {
    await rawPrisma.projectFeature.update({ where: { projectId_key: { projectId, key: "OMNICHANNEL" } }, data: { enabled: false } });
    resetProjectFeatureCacheForTests();
    try {
      const e = await event(conn.messenger, metaEvent(inbound("U5", `m.off.${tag}`, "anyone?")));
      await runChannelInboundTick(new Date(), fakeFetch);
      expect((await rawPrisma.channelInboundEvent.findUniqueOrThrow({ where: { id: e.id } })).status).toBe("PENDING");
    } finally {
      await rawPrisma.projectFeature.update({ where: { projectId_key: { projectId, key: "OMNICHANNEL" } }, data: { enabled: true } });
      resetProjectFeatureCacheForTests();
    }
    await runChannelInboundTick(new Date(), fakeFetch);
    expect(await rawPrisma.channelInboundEvent.count({ where: { projectId, status: "PENDING" } })).toBe(0);
  });
});

describe("2. echoes and receipts", () => {
  it("the echo of our own Messenger send (its metadata) is not stored a second time", async () => {
    const c = await conversationOf(conn.messenger, "U1");
    const ours = await queue(c.id, conn.messenger, "MESSENGER");
    await run(() => sendNextQueued(new Date(), fakeFetch));
    const sent = await rawPrisma.channelMessage.findUniqueOrThrow({ where: { id: ours.id } });
    expect(sent.deliveryStatus).toBe("SENT");
    expect(fake.sends[0]!.body).toMatchObject({ recipient: { id: "U1" }, messaging_type: "RESPONSE", message: { text: "We are on it", metadata: ours.id } });
    await process_(await event(conn.messenger, metaEvent({ sender: { id: PAGE_ID }, recipient: { id: "U1" }, timestamp: Date.now(), message: { mid: sent.externalMessageId, text: "We are on it", is_echo: true, metadata: ours.id, app_id: 123456789012 } })));
    expect(await rawPrisma.channelMessage.count({ where: { conversationId: c.id, direction: "OUTBOUND" } })).toBe(1);
  });

  it("an echo that outruns the send's own response takes the in-flight row, and the send completes on it", async () => {
    const c = await conversationOf(conn.messenger, "U1");
    const ours = await queue(c.id, conn.instagram, "INSTAGRAM", { text: "race reply" });
    await rawPrisma.channelMessage.update({ where: { id: ours.id }, data: { deliveryStatus: "SENDING", sendingStartedAt: new Date() } });
    await process_(await event(conn.messenger, metaEvent({ sender: { id: PAGE_ID }, recipient: { id: "U1" }, timestamp: Date.now(), message: { mid: `m.race.${tag}`, text: "race reply", is_echo: true } })));
    expect((await rawPrisma.channelMessage.findUniqueOrThrow({ where: { id: ours.id } })).externalMessageId).toBe(`m.race.${tag}`);
    expect(await rawPrisma.channelMessage.count({ where: { externalMessageId: `m.race.${tag}` } })).toBe(1);
  });

  it("an echo carrying our metadata is recognised even when its text differs from what we queued", async () => {
    const c = await conversationOf(conn.messenger, "U1");
    const ours = await queue(c.id, conn.messenger, "MESSENGER", { text: "Hello  there" });
    await rawPrisma.channelMessage.update({ where: { id: ours.id }, data: { deliveryStatus: "SENDING", sendingStartedAt: new Date() } });
    await process_(await event(conn.messenger, metaEvent({ sender: { id: PAGE_ID }, recipient: { id: "U1" }, timestamp: Date.now(), message: { mid: `m.meta.${tag}`, text: "Hello there", is_echo: true, metadata: ours.id } })));
    expect((await rawPrisma.channelMessage.findUniqueOrThrow({ where: { id: ours.id } })).externalMessageId).toBe(`m.meta.${tag}`);
    expect(await rawPrisma.channelMessage.count({ where: { conversationId: c.id, senderType: "BUSINESS" } })).toBe(0);
  });

  it("a person replying from Meta Business Suite is stored as that, and AI steps back", async () => {
    const c = await conversationOf(conn.messenger, "U1");
    await rawPrisma.channelConversation.update({ where: { id: c.id }, data: { aiSuppressedUntil: null } });
    await process_(await event(conn.messenger, metaEvent({ sender: { id: PAGE_ID }, recipient: { id: "U1" }, timestamp: Date.now(), message: { mid: `m.suite.${tag}`, text: "Hi, Karim here", is_echo: true } })));
    const row = await rawPrisma.channelMessage.findFirstOrThrow({ where: { externalMessageId: `m.suite.${tag}` } });
    expect(row).toMatchObject({ senderType: "BUSINESS", direction: "OUTBOUND", deliveryStatus: "SENT" });
    expect((await conversationOf(conn.messenger, "U1")).aiSuppressedUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it("receipts move messages forward only", async () => {
    const c = await conversationOf(conn.messenger, "U1");
    const sent = await rawPrisma.channelMessage.findFirstOrThrow({ where: { conversationId: c.id, senderType: "AGENT", deliveryStatus: "SENT", text: "We are on it" } });
    await process_(await event(conn.messenger, metaEvent({ sender: { id: "U1" }, recipient: { id: PAGE_ID }, timestamp: Date.now(), read: { watermark: Date.now() + 1000 } })));
    expect((await rawPrisma.channelMessage.findUniqueOrThrow({ where: { id: sent.id } })).deliveryStatus).toBe("READ");
    await process_(await event(conn.messenger, metaEvent({ sender: { id: "U1" }, recipient: { id: PAGE_ID }, timestamp: Date.now(), delivery: { mids: [sent.externalMessageId], watermark: Date.now() } })));
    expect((await rawPrisma.channelMessage.findUniqueOrThrow({ where: { id: sent.id } })).deliveryStatus).toBe("READ");
  });
});

describe("3. the send queue", () => {
  it("a temporary refusal is retried later; a dead credential fails and marks the connection", async () => {
    const c = await conversationOf(conn.telegram, "4242");
    const m = await queue(c.id, conn.telegram, "TELEGRAM");
    fake.next.push("rate");
    const now = new Date();
    await run(() => sendNextQueued(now, fakeFetch));
    const retried = await rawPrisma.channelMessage.findUniqueOrThrow({ where: { id: m.id } });
    expect(retried).toMatchObject({ deliveryStatus: "QUEUED", attempts: 1 });
    expect(retried.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(now.getTime() + 30_000);
    // Not due yet: nothing is sent.
    expect(await run(() => sendNextQueued(now, fakeFetch))).toBe(false);
    fake.next.push("token");
    await run(() => sendNextQueued(new Date(now.getTime() + 60_000), fakeFetch));
    expect(await rawPrisma.channelMessage.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ deliveryStatus: "FAILED" });
    expect(await rawPrisma.channelConnection.findUniqueOrThrow({ where: { id: conn.telegram } })).toMatchObject({ status: "NEEDS_RECONNECT" });
    // A reply queued for a connection that needs new credentials is not attempted at all.
    const next = await queue(c.id, conn.telegram, "TELEGRAM");
    await run(() => sendNextQueued(new Date(), fakeFetch));
    expect(fake.sends).toHaveLength(2);
    expect((await rawPrisma.channelMessage.findUniqueOrThrow({ where: { id: next.id } })).deliveryStatus).toBe("FAILED");
    await rawPrisma.channelConnection.update({ where: { id: conn.telegram }, data: { status: "CONNECTED" } });
  });

  it("an outcome nobody can know is UNKNOWN and never retried by itself; a stuck SENDING becomes UNKNOWN too", async () => {
    const c = await conversationOf(conn.telegram, "4242");
    const m = await queue(c.id, conn.telegram, "TELEGRAM");
    fake.next.push("timeout");
    await run(() => sendNextQueued(new Date(), fakeFetch));
    expect(await rawPrisma.channelMessage.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ deliveryStatus: "UNKNOWN", nextAttemptAt: null });
    expect(await run(() => sendNextQueued(new Date(), fakeFetch))).toBe(false);

    const stuck = await queue(c.id, conn.telegram, "TELEGRAM", { deliveryStatus: "SENDING", sendingStartedAt: new Date(Date.now() - STUCK_SENDING_MS - 1000) });
    const { runChannelOutboundTick } = await import("../channels/outboundProcessor.js");
    await runChannelOutboundTick(new Date(), fakeFetch);
    expect((await rawPrisma.channelMessage.findUniqueOrThrow({ where: { id: stuck.id } })).deliveryStatus).toBe("UNKNOWN");
  });

  it("the window is checked again at send time, and a HUMAN_AGENT reply carries its tag", async () => {
    const c = await conversationOf(conn.messenger, "U1");
    await rawPrisma.channelConversation.update({ where: { id: c.id }, data: { lastInboundAt: new Date(Date.now() - 30 * 3_600_000) } });
    const refused = await queue(c.id, conn.messenger, "MESSENGER");
    await run(() => sendNextQueued(new Date(), fakeFetch));
    expect(fake.sends).toHaveLength(0);
    expect((await rawPrisma.channelMessage.findUniqueOrThrow({ where: { id: refused.id } })).lastError).toMatch(/Human Agent/);
    await rawPrisma.channelConnection.update({ where: { id: conn.messenger }, data: { humanAgentEnabled: true } });
    const tagged = await queue(c.id, conn.messenger, "MESSENGER");
    await run(() => sendNextQueued(new Date(), fakeFetch));
    expect(fake.sends[0]!.body).toMatchObject({ messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" });
    expect(await rawPrisma.channelMessage.findUniqueOrThrow({ where: { id: tagged.id } })).toMatchObject({ deliveryStatus: "SENT", messagingTag: "HUMAN_AGENT" });
    await rawPrisma.channelConnection.update({ where: { id: conn.messenger }, data: { humanAgentEnabled: false } });
    await rawPrisma.channelConversation.update({ where: { id: c.id }, data: { lastInboundAt: new Date() } });
  });

  it("an AI reply is dropped, not sent, if automation was switched off after it was written", async () => {
    const c = await conversationOf(conn.messenger, "U1");
    await rawPrisma.automationSettings.update({ where: { projectId }, data: { automationEnabled: false } });
    const ai = await queue(c.id, conn.messenger, "MESSENGER", { senderType: "AI" });
    await run(() => sendNextQueued(new Date(), fakeFetch));
    expect(fake.sends).toHaveLength(0);
    expect((await rawPrisma.channelMessage.findUniqueOrThrow({ where: { id: ai.id } })).deliveryStatus).toBe("FAILED");
  });
});

describe("4. AI replies", () => {
  const ANSWER = "INTENT: outage\nSCOPE: BUSINESS_SPECIFIC\nCONFIDENCE: 95\nSHOULD_REPLY: YES\nRESPONSE: Please restart the router; if the red light stays, we will send a technician.";
  let knowledgeId = "";

  beforeAll(async () => {
    await rawPrisma.automationSettings.update({ where: { projectId }, data: { automationEnabled: true, mode: "SAFE_AUTO_REPLY" } });
    await rawPrisma.aiSettings.update({ where: { projectId }, data: { aiEngineEnabled: true, autoResponseEnabled: true, aiResponseMode: "STRICT_KNOWLEDGE_ONLY", aiReplyCooldownSeconds: 0, autoResponseConfidenceThreshold: 70 } });
    await rawPrisma.channelConnection.updateMany({ where: { projectId }, data: { aiAutomationEnabled: true } });
    knowledgeId = (
      await rawPrisma.aiKnowledgeItem.create({
        data: { projectId, title: "Router red light", category: "TROUBLESHOOTING", question: "What should a customer do when the router light is red?", answer: "Restart the router. If the red light stays, a technician visits.", status: "ACTIVE", humanVerified: true },
      })
    ).id;
  });

  async function customerSays(thread: string, text: string, connectionId = conn.messenger) {
    const mid = `m.ai.${randomUUID()}`;
    await process_(await event(connectionId, metaEvent(inbound(thread, mid, text))));
    const row = await rawPrisma.channelMessage.findFirstOrThrow({ where: { externalMessageId: mid } });
    // Old enough to have settled.
    await rawPrisma.channelMessage.update({ where: { id: row.id }, data: { createdAt: new Date(Date.now() - AI_SETTLE_MS - 1000) } });
    return row.id;
  }

  it("answers a covered question once, through the send queue, however often it is asked to", async () => {
    const id = await customerSays(`AIU1${tag}`, "router light is red what should I do");
    const client = new MockAiClient();
    client.queuedTexts = [ANSWER, ANSWER, ANSWER];
    const outcome = await run(() => answerChannelMessage(id, new Date(), client));
    expect(outcome).toMatchObject({ outcome: "REPLIED", confidence: 95 });
    expect(await run(() => answerChannelMessage(id, new Date(), client))).toBeNull();
    const replies = await rawPrisma.channelMessage.findMany({ where: { senderType: "AI", idempotencyKey: `ai:${id}` } });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ deliveryStatus: "QUEUED", messagingType: "RESPONSE", text: expect.stringContaining("restart the router") });
    expect(await rawPrisma.channelMessage.findUniqueOrThrow({ where: { id } })).toMatchObject({ aiOutcome: "REPLIED", aiReplyMessageId: replies[0]!.id });
  });

  it("hands over a question nothing verified covers, and raises the team alert", async () => {
    const id = await customerSays(`AIU2${tag}`, "can I pay my bill with crypto");
    const client = new MockAiClient();
    client.queuedTexts = ["crypto, payment", ANSWER];
    const outcome = await run(() => answerChannelMessage(id, new Date(), client));
    expect(outcome).toMatchObject({ outcome: "HANDED_OVER", reason: "NO_KNOWLEDGE" });
    expect(await rawPrisma.channelMessage.count({ where: { idempotencyKey: `ai:${id}` } })).toBe(0);
  });

  it("stays out while a person is handling the conversation, and answers only the customer's latest message", async () => {
    const thread = `AIU3${tag}`;
    const older = await customerSays(thread, "router light is red");
    const newer = await customerSays(thread, "router light is red still");
    await rawPrisma.channelMessage.update({ where: { id: newer }, data: { createdAt: new Date(Date.now() - AI_SETTLE_MS - 500) } });
    const client = new MockAiClient();
    client.nextText = ANSWER;
    expect(await run(() => answerChannelMessage(older, new Date(), client))).toMatchObject({ outcome: "SKIPPED", reason: expect.stringMatching(/another message/) });
    const c = await conversationOf(conn.messenger, thread);
    await rawPrisma.channelConversation.update({ where: { id: c.id }, data: { aiSuppressedUntil: new Date(Date.now() + 600_000) } });
    expect(await run(() => answerChannelMessage(newer, new Date(), client))).toMatchObject({ outcome: "SKIPPED", reason: "A person is handling this conversation." });
    expect(client.requests).toHaveLength(0);
  });

  it("never answers in a group chat, and never with the kill switch on", async () => {
    await process_(await event(conn.telegram, { provider: "TELEGRAM", update: { update_id: 77, message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: -555, type: "supergroup", title: "Ops" }, from: { id: 9, is_bot: false, first_name: "Ali" }, text: "router light is red" } } }));
    const groupMessage = await rawPrisma.channelMessage.findFirstOrThrow({ where: { externalMessageId: "-555:1" } });
    const client = new MockAiClient();
    client.nextText = ANSWER;
    expect(await run(() => answerChannelMessage(groupMessage.id, new Date(), client))).toMatchObject({ outcome: "SKIPPED", reason: "AI does not answer in group chats." });
    const id = await customerSays(`AIU4${tag}`, "router light is red");
    await rawPrisma.automationSettings.update({ where: { projectId }, data: { automationEnabled: false } });
    try {
      expect(await run(() => answerChannelMessage(id, new Date(), client))).toMatchObject({ outcome: "SKIPPED", reason: expect.stringMatching(/kill switch/) });
    } finally {
      await rawPrisma.automationSettings.update({ where: { projectId }, data: { automationEnabled: true } });
    }
    expect(client.requests).toHaveLength(0);
  });

  it("the business-question guard holds even in the permissive mode", async () => {
    await rawPrisma.aiSettings.update({ where: { projectId }, data: { aiResponseMode: "KNOWLEDGE_PLUS_GENERAL" } });
    await rawPrisma.aiKnowledgeItem.update({ where: { id: knowledgeId }, data: { status: "ARCHIVED" } });
    try {
      const id = await customerSays(`AIU5${tag}`, "how many days for a refund on my invoice");
      const client = new MockAiClient();
      // Every call answers the same: an expansion (if one runs) finds nothing, and the reply is a confident business claim.
      client.nextText = "INTENT: refund\nSCOPE: BUSINESS_SPECIFIC\nCONFIDENCE: 99\nSHOULD_REPLY: YES\nRESPONSE: We refund within 14 days.";
      expect(await run(() => answerChannelMessage(id, new Date(), client))).toMatchObject({ outcome: "HANDED_OVER", reason: "NO_BUSINESS_KNOWLEDGE" });
    } finally {
      await rawPrisma.aiSettings.update({ where: { projectId }, data: { aiResponseMode: "STRICT_KNOWLEDGE_ONLY" } });
      await rawPrisma.aiKnowledgeItem.update({ where: { id: knowledgeId }, data: { status: "ACTIVE" } });
    }
  });
});
