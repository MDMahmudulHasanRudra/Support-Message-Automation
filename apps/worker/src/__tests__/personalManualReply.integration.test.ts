import "./helpers/requireTestDatabase.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomInt, randomUUID } from "node:crypto";
import { prisma, inIsp, ISP_DIGITAL } from "./helpers/projectFixtures.js";
import { processOne } from "../queue/outboundQueueProcessor.js";
import { MockProvider } from "./mockProvider.js";

/**
 * A reply typed into a PERSONAL (one-to-one) chat in WhatsApp Chat. It rides the one outbound queue
 * like a group reply, but its live pre-send check is the personal one: the chat must be an
 * individual chat that exists on the account (`verifyPersonalChat`) — never the group-membership
 * check, which a one-to-one chat can never pass, and never a send into a chat that is not there.
 */

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const digits = () => `88017${randomInt(10_000_000, 99_999_999)}`;
let accountId = "";
const ids: string[] = [];

async function queueManualReply(chatId: string, body: string) {
  const row = await prisma.outboundMessage.create({
    data: {
      projectId: ISP_DIGITAL,
      accountId,
      chatId,
      toPhone: chatId,
      body,
      actionType: "MANUAL_REPLY",
      idempotencyKey: `pmr-${tag}-${randomUUID()}`,
      // Explicit, so the DB clock running ahead of the host cannot make it not-yet-due.
      scheduledAt: new Date(Date.now() - 60_000),
    },
  });
  ids.push(row.id);
  return row.id;
}

/** Drains the queue until this row has been settled (other files' leftovers are processed too). */
async function drainUntilSettled(provider: MockProvider, id: string) {
  for (let i = 0; i < 50; i++) {
    const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { id } });
    if (row.status !== "PENDING" && row.status !== "PROCESSING") return row;
    if (!(await inIsp(() => processOne(provider)))) break;
  }
  return prisma.outboundMessage.findUniqueOrThrow({ where: { id } });
}

beforeAll(async () => {
  const account = await prisma.whatsAppAccount.create({ data: { projectId: ISP_DIGITAL, label: `PMR ${tag}`, status: "CONNECTED" } });
  accountId = account.id;
});

afterAll(async () => {
  await prisma.outboundMessage.deleteMany({ where: { id: { in: ids } } });
  await prisma.whatsAppAccount.deleteMany({ where: { id: accountId } });
});

describe("a manual reply to a personal chat", () => {
  it("is sent after the personal-chat check — the group check is never asked", async () => {
    const provider = new MockProvider();
    const chatId = `${digits()}@c.us`;
    provider.personalChats.add(chatId);
    // A one-to-one chat is not a group: if the queue asked the group question it would be refused.
    provider.membershipByChatId.set(chatId, false);
    const id = await queueManualReply(chatId, `Ok brother ${tag}`);

    const row = await drainUntilSettled(provider, id);
    expect(row.status).toBe("SENT");
    expect(provider.sentMessages).toContainEqual({ chatId, body: `Ok brother ${tag}` });
    expect(provider.personalChecks).toContain(chatId);
  });

  it("works for a @lid chat, where WhatsApp hides the number", async () => {
    const provider = new MockProvider();
    const chatId = `1${randomInt(10_000_000, 99_999_999)}${randomInt(100_000, 999_999)}@lid`;
    provider.personalChats.add(chatId);
    const id = await queueManualReply(chatId, `Hello ${tag}`);
    expect((await drainUntilSettled(provider, id)).status).toBe("SENT");
  });

  it("is SKIPPED, with the reason, when the chat is not on this account — nothing is sent", async () => {
    const provider = new MockProvider();
    const chatId = `${digits()}@c.us`;
    const id = await queueManualReply(chatId, `Stranger ${tag}`);

    const row = await drainUntilSettled(provider, id);
    expect(row).toMatchObject({ status: "SKIPPED", failureReason: expect.stringMatching(/could not be found on this WhatsApp account/) });
    expect(provider.sentMessages.some((m) => m.chatId === chatId)).toBe(false);
  });

  it("the status broadcast is never a chat to reply into", async () => {
    const provider = new MockProvider();
    const id = await queueManualReply("status@broadcast", `Status ${tag}`);
    expect((await drainUntilSettled(provider, id)).status).toBe("SKIPPED");
    expect(provider.sentMessages).toEqual([]);
  });

  it("a group reply still uses the group membership check, unchanged", async () => {
    const provider = new MockProvider();
    const groupChat = `1203630${randomInt(10_000_000, 99_999_999)}@g.us`;
    provider.membershipByChatId.set(groupChat, false);
    const id = await queueManualReply(groupChat, `Group ${tag}`);

    const row = await drainUntilSettled(provider, id);
    expect(row).toMatchObject({ status: "SKIPPED", failureReason: expect.stringMatching(/no longer a member of the group/) });
    expect(provider.personalChecks).not.toContain(groupChat);
  });
});
