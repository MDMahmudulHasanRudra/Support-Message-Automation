import "./helpers/requireTestDatabase.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "./helpers/projectFixtures.js";
import type { AutomationSettings, WhatsAppAccount } from "@prisma/client";
import { processIncomingMessage } from "../pipeline/processIncomingMessage.js";
import type { RawIncomingMessage } from "../pipeline/types.js";

/**
 * Only the Primary account answers customers.
 *
 * Every connected account collects messages, and every one of them used to be able to reply too —
 * so a second number meant two voices answering in any group both were in, and a spare number
 * linked just to watch the inbox would start speaking to customers on its own.
 *
 * The tests below pin the two halves that matter: a non-Primary account stays silent, and the
 * evidence-gathering above the gate keeps running for it anyway — a number that does not reply
 * must still count towards who was working.
 */

let primaryAccount: WhatsAppAccount;
let secondaryAccount: WhatsAppAccount;
let settings: AutomationSettings;
/** Whatever the database had before, restored afterwards — `isPrimary` is a shared singleton. */
let previousPrimaryId: string | null = null;

async function makeGroup(account: WhatsAppAccount) {
  return prisma.whatsAppGroup.create({
    data: {
      accountId: account.id,
      whatsappGroupId: `${randomUUID().replace(/-/g, "").slice(0, 12)}-1234567890@g.us`,
      name: `Primary Only Group ${randomUUID().slice(0, 8)}`,
      isMonitored: true,
      isActive: true,
    },
  });
}

function incoming(account: WhatsAppAccount, chatId: string, body: string): RawIncomingMessage {
  return {
    accountId: account.id,
    whatsappMessageId: `msg-${randomUUID()}`,
    chatId,
    senderPhone: "8801700000001",
    senderName: "A Customer",
    body,
    direction: "INCOMING",
    timestampWa: new Date(),
    isGroup: true,
    mentionedPhones: [],
  } as RawIncomingMessage;
}

beforeAll(async () => {
  const existing = await prisma.whatsAppAccount.findFirst({ where: { isPrimary: true }, select: { id: true } });
  previousPrimaryId = existing?.id ?? null;
  if (existing) {
    await prisma.whatsAppAccount.update({ where: { id: existing.id }, data: { isPrimary: false } });
  }

  primaryAccount = await prisma.whatsAppAccount.create({
    data: { label: `Primary Replier ${randomUUID()}`, status: "CONNECTED", isPrimary: true },
  });
  secondaryAccount = await prisma.whatsAppAccount.create({
    data: { label: `Secondary Silent ${randomUUID()}`, status: "CONNECTED", isPrimary: false },
  });

  settings = await prisma.automationSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
  await prisma.automationSettings.update({
    where: { id: "global" },
    data: { automationEnabled: true, mode: "FULL_RULE_AUTOMATION", rateLimitingEnabled: false },
  });
});

beforeEach(async () => {
  await prisma.automationRule.deleteMany({ where: { name: { startsWith: "PrimaryOnly " } } });
});

afterEach(async () => {
  await prisma.automationRule.deleteMany({ where: { name: { startsWith: "PrimaryOnly " } } });
});

afterAll(async () => {
  await prisma.whatsAppAccount.delete({ where: { id: primaryAccount.id } }).catch(() => {});
  await prisma.whatsAppAccount.delete({ where: { id: secondaryAccount.id } }).catch(() => {});
  if (previousPrimaryId) {
    await prisma.whatsAppAccount
      .update({ where: { id: previousPrimaryId }, data: { isPrimary: true } })
      .catch(() => {});
  }
  await prisma.automationSettings.update({
    where: { id: "global" },
    data: settings as unknown as Record<string, never>,
  }).catch(() => {});
});

/** An always-matching auto-reply rule, so any silence is the account gate and nothing else. */
async function makeReplyRule() {
  return prisma.automationRule.create({
    data: {
      name: `PrimaryOnly ${randomUUID().slice(0, 8)}`,
      type: "AUTO_REPLY",
      status: "ACTIVE",
      priority: 100,
      matchType: "CONTAINS",
      matchValue: "invoice",
      // Without an action the engine can match and still execute nothing, which would make every
      // assertion below pass for the wrong reason.
      actions: [{ type: "AUTO_REPLY" }],
      replyMessage: "We have your invoice question.",
    },
  });
}

describe("a reply goes out only from the Primary account", () => {
  it("replies to a message that arrived on the Primary account", async () => {
    await makeReplyRule();
    const group = await makeGroup(primaryAccount);

    await processIncomingMessage(incoming(primaryAccount, group.whatsappGroupId, "invoice please"));

    const queued = await prisma.outboundMessage.findMany({
      where: { accountId: primaryAccount.id, actionType: "AUTO_REPLY" },
    });
    expect(queued.length).toBeGreaterThan(0);
  });

  it("stays silent for the same message on a non-Primary account", async () => {
    await makeReplyRule();
    const group = await makeGroup(secondaryAccount);

    await processIncomingMessage(incoming(secondaryAccount, group.whatsappGroupId, "invoice please"));

    // The point of the whole change: ten connected accounts must not mean ten replies.
    const queued = await prisma.outboundMessage.findMany({ where: { accountId: secondaryAccount.id } });
    expect(queued).toHaveLength(0);
  });

  it("still stores and settles the non-Primary message rather than leaving it stranded", async () => {
    const group = await makeGroup(secondaryAccount);
    const raw = incoming(secondaryAccount, group.whatsappGroupId, "invoice please");

    await processIncomingMessage(raw);

    const stored = await prisma.message.findFirst({ where: { whatsappMessageId: raw.whatsappMessageId } });
    expect(stored).not.toBeNull();
    // PENDING would make recoverStrandedMessages re-run it every few hours forever.
    expect(stored!.processingStatus).toBe("PROCESSED");
  });

  it("moves the checkpoint for the non-Primary account too", async () => {
    const group = await makeGroup(secondaryAccount);
    const raw = incoming(secondaryAccount, group.whatsappGroupId, "invoice please");

    await processIncomingMessage(raw);

    // catchUpMissedMessages reads this to know where a gap begins. A message this worker genuinely
    // saw and decided about must not later look like one it missed.
    const checkpoint = await prisma.processingCheckpoint.findUnique({
      where: { accountId: secondaryAccount.id },
    });
    expect(checkpoint).not.toBeNull();
  });
});

/**
 * The deliberate half, and the opposite of what "only Primary replies" first suggests.
 *
 * The rule exists to stop a SECOND number joining in — not to make a missing setting silently
 * switch customer replies off everywhere. A deployment that never touched the setting, or one
 * where somebody pressed Remove Primary, would otherwise go quiet across every group with nothing
 * on screen explaining it: a worse failure than the one being prevented.
 */
describe("with no Primary account set", () => {
  it("falls back to the receiving account rather than going silent", async () => {
    await makeReplyRule();
    const group = await makeGroup(primaryAccount);
    // Counted before, because an earlier test in this file legitimately queued one on this same
    // account — what is under test is that THIS message adds nothing, not that the table is empty.
    const before = await prisma.outboundMessage.count({ where: { accountId: primaryAccount.id } });
    await prisma.whatsAppAccount.update({ where: { id: primaryAccount.id }, data: { isPrimary: false } });

    try {
      await processIncomingMessage(incoming(primaryAccount, group.whatsappGroupId, "invoice please"));

      const after = await prisma.outboundMessage.count({ where: { accountId: primaryAccount.id } });
      expect(after).toBeGreaterThan(before);
    } finally {
      await prisma.whatsAppAccount.update({ where: { id: primaryAccount.id }, data: { isPrimary: true } });
    }
  });
});
