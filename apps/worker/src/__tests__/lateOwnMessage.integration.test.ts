import "./helpers/requireTestDatabase.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomInt, randomUUID } from "node:crypto";
import type { WhatsAppAccount, WhatsAppGroup } from "@prisma/client";
import { prisma, ISP_DIGITAL } from "./helpers/projectFixtures.js";
import { storeMissedMessage } from "../pipeline/processIncomingMessage.js";
import { resetOwnAccountCacheForTests } from "../pipeline/ownAccounts.js";
import type { RawIncomingMessage } from "../pipeline/types.js";

/**
 * Report accuracy audit (19 Oct 2026): a message one of our OTHER numbers posted, recovered more than
 * fifteen minutes late (after a restart or a reconnect), is stored as the business's own message —
 * exactly as the live path stores it. It used to go straight in as INCOMING: a "customer" message
 * that opened a wait (Unanswered Groups, Response Time) and could open a Support Assignment case
 * against our own reply.
 */

const RUN = String(randomInt(100_000, 999_999));
const OUR_A = `88017${RUN}0001`.slice(0, 13);
const WGID = `120368${Date.now()}${RUN}@g.us`;
let accountA: WhatsAppAccount;
let accountB: WhatsAppAccount;
let groupB: WhatsAppGroup;

function raw(overrides: Partial<RawIncomingMessage> = {}): RawIncomingMessage {
  return {
    accountId: accountB.id,
    whatsappMessageId: `false_${WGID}_${randomUUID()}_${OUR_A}@c.us`,
    chatId: WGID,
    whatsappGroupId: WGID,
    senderPhone: OUR_A,
    senderJid: `${OUR_A}@c.us`,
    senderName: null,
    direction: "INCOMING",
    body: "We have fixed it",
    // Two hours ago: far outside the catch-up's automation window.
    timestampWa: new Date(Date.now() - 2 * 3_600_000),
    ...overrides,
  };
}

beforeAll(async () => {
  accountA = await prisma.whatsAppAccount.create({ data: { projectId: ISP_DIGITAL, label: `Late A ${RUN}`, status: "CONNECTED", phoneNumber: `+${OUR_A}` } });
  accountB = await prisma.whatsAppAccount.create({ data: { projectId: ISP_DIGITAL, label: `Late B ${RUN}`, status: "CONNECTED" } });
  groupB = await prisma.whatsAppGroup.create({
    data: { projectId: ISP_DIGITAL, accountId: accountB.id, whatsappGroupId: WGID, name: `Late ${RUN}`, isMonitored: true, isActive: true, lastSyncedAt: new Date() },
  });
  resetOwnAccountCacheForTests();
});

afterAll(async () => {
  await prisma.message.deleteMany({ where: { accountId: { in: [accountA.id, accountB.id] } } });
  await prisma.whatsAppGroup.deleteMany({ where: { id: groupB.id } });
  await prisma.whatsAppAccount.deleteMany({ where: { id: { in: [accountA.id, accountB.id] } } });
  await prisma.$disconnect();
});

describe("a late-recovered message from another of our numbers", () => {
  it("is stored as the business's own message, never as a customer's", async () => {
    const message = raw();
    expect(await storeMissedMessage(message)).toBe(true);
    const row = await prisma.message.findFirstOrThrow({ where: { accountId: accountB.id, whatsappMessageId: message.whatsappMessageId } });
    expect(row.direction).toBe("OUTGOING");
    expect(row.isFromTeamMember).toBe(false);
    expect(await prisma.supportResponseEpisode.count({ where: { groupId: groupB.id } })).toBe(0);
  });

  it("control: a customer's late message is still stored as INCOMING", async () => {
    const customer = `88019${RUN}9999`.slice(0, 13);
    const message = raw({ senderPhone: customer, senderJid: `${customer}@c.us`, whatsappMessageId: `false_${WGID}_${randomUUID()}_${customer}@c.us` });
    expect(await storeMissedMessage(message)).toBe(true);
    const row = await prisma.message.findFirstOrThrow({ where: { accountId: accountB.id, whatsappMessageId: message.whatsappMessageId } });
    expect(row.direction).toBe("INCOMING");
  });
});
