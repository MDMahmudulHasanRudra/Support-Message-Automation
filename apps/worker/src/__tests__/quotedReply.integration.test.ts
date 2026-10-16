import "./helpers/requireTestDatabase.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomInt, randomUUID } from "node:crypto";
import { prisma, inIsp, ISP_DIGITAL } from "./helpers/projectFixtures.js";
import { processOne } from "../queue/outboundQueueProcessor.js";
import { MockProvider } from "./mockProvider.js";

/**
 * WhatsApp Chat v2 (CHAT_UI_V2.md §4): a manual reply that quotes a stored message. The queue must
 * hand the provider the quoted message's WhatsApp id — that is what makes it a real WhatsApp reply —
 * and must refuse, without sending anything, a target that is not this chat's on this account. Every
 * send without a quote must reach the provider exactly as before (no options at all).
 */

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
let accountId = "";
let otherAccountId = "";
const groupChat = `1203630${randomInt(10_000_000, 99_999_999)}@g.us`;
const otherChat = `1203631${randomInt(10_000_000, 99_999_999)}@g.us`;
const outbound: string[] = [];
const messages: string[] = [];

async function storedMessage(onAccount: string, chatId: string, waId: string) {
  const row = await prisma.message.create({
    data: {
      projectId: ISP_DIGITAL,
      accountId: onAccount,
      chatId,
      whatsappMessageId: waId,
      senderPhone: "88017000000",
      direction: "INCOMING",
      body: "is the internet down?",
      normalizedBody: "is the internet down?",
      timestampWa: new Date(Date.now() - 120_000),
      processingStatus: "PROCESSED",
    },
  });
  messages.push(row.id);
  return row;
}

async function queueReply(body: string, replyToMessageId: string | null) {
  const row = await prisma.outboundMessage.create({
    data: {
      projectId: ISP_DIGITAL,
      accountId,
      chatId: groupChat,
      toPhone: groupChat,
      body,
      actionType: "MANUAL_REPLY",
      replyToMessageId,
      idempotencyKey: `qr-${tag}-${randomUUID()}`,
      scheduledAt: new Date(Date.now() - 60_000),
    },
  });
  outbound.push(row.id);
  return row.id;
}

async function drainUntilSettled(provider: MockProvider, id: string) {
  for (let i = 0; i < 50; i++) {
    const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { id } });
    if (row.status !== "PENDING" && row.status !== "PROCESSING") return row;
    if (!(await inIsp(() => processOne(provider)))) break;
  }
  return prisma.outboundMessage.findUniqueOrThrow({ where: { id } });
}

beforeAll(async () => {
  accountId = (await prisma.whatsAppAccount.create({ data: { projectId: ISP_DIGITAL, label: `QR ${tag}`, status: "CONNECTED" } })).id;
  otherAccountId = (await prisma.whatsAppAccount.create({ data: { projectId: ISP_DIGITAL, label: `QR other ${tag}`, status: "CONNECTED" } })).id;
});

afterAll(async () => {
  await prisma.outboundMessage.deleteMany({ where: { id: { in: outbound } } });
  await prisma.message.deleteMany({ where: { id: { in: messages } } });
  await prisma.whatsAppAccount.deleteMany({ where: { id: { in: [accountId, otherAccountId] } } });
});

describe("a quoted manual reply", () => {
  it("reaches the provider with the quoted message's WhatsApp id", async () => {
    const quoted = await storedMessage(accountId, groupChat, `false_${groupChat}_QR${tag}A_88017000000@c.us`);
    const provider = new MockProvider();
    provider.membershipByChatId.set(groupChat, true);
    const id = await queueReply(`Checking now ${tag}`, quoted.id);

    const row = await drainUntilSettled(provider, id);
    expect(row.status).toBe("SENT");
    const index = provider.sentMessages.findIndex((m) => m.body === `Checking now ${tag}`);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(provider.sentExtras[index]).toEqual({ mentions: [], quotedMessageId: quoted.whatsappMessageId });
  });

  it("is refused without sending when the target is another chat's, or another account's copy", async () => {
    const provider = new MockProvider();
    provider.membershipByChatId.set(groupChat, true);
    const elsewhere = await storedMessage(accountId, otherChat, `false_${otherChat}_QR${tag}B_88017000000@c.us`);
    const otherAccountsCopy = await storedMessage(otherAccountId, groupChat, `false_${groupChat}_QR${tag}C_88017000000@c.us`);
    for (const target of [elsewhere, otherAccountsCopy]) {
      const id = await queueReply(`Wrong quote ${target.id}`, target.id);
      const row = await drainUntilSettled(provider, id);
      expect(row.status).toBe("FAILED");
      expect(row.failureReason).toMatch(/not in this conversation/);
      expect(provider.sentMessages.some((m) => m.body === `Wrong quote ${target.id}`)).toBe(false);
    }
  });

  it("leaves an unquoted reply on its old path: no options passed at all", async () => {
    const provider = new MockProvider();
    provider.membershipByChatId.set(groupChat, true);
    const id = await queueReply(`Plain ${tag}`, null);
    expect((await drainUntilSettled(provider, id)).status).toBe("SENT");
    const index = provider.sentMessages.findIndex((m) => m.body === `Plain ${tag}`);
    expect(provider.sentExtras[index]).toEqual({ mentions: [], quotedMessageId: null });
  });
});
