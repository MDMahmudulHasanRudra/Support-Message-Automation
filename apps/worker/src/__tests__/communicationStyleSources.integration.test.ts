import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@support-automation/db";
import type { AiClient } from "@support-automation/ai-client";
import { buildCommunicationStyleProfile } from "../knowledge/communicationStyleJob.js";

/**
 * What the style builder reads, and — more importantly — what it must not silently drop.
 *
 * The bug these exist for: `groupId: { notIn: [...] }` looks like it excludes the notification
 * groups, but SQL's NOT IN never matches NULL, so it also discarded every message whose group was
 * never resolved. On the live database that was 319 of 361 outgoing messages, and the first real
 * build ran on 2 replies instead of ~336 — reporting success the whole way. A filter that quietly
 * throws away most of its input is worse than one that errors.
 */

const created: { accounts: string[]; groups: string[] } = { accounts: [], groups: [] };

/** Returns fixed guidance so these tests exercise the QUERY, not the model. */
function stubClient(): AiClient {
  return {
    async complete() {
      return {
        text: ["- Greet the customer before answering", "- Keep replies short"].join("\n"),
        tokensUsed: 0,
        providerId: "test",
        modelId: "test",
      };
    },
  };
}

async function makeAccount() {
  const account = await prisma.whatsAppAccount.create({
    data: { label: `Style Test ${randomUUID()}`, status: "CONNECTED" },
  });
  created.accounts.push(account.id);
  return account;
}

async function makeGroup(accountId: string) {
  const group = await prisma.whatsAppGroup.create({
    data: {
      accountId,
      whatsappGroupId: `${randomUUID().replace(/-/g, "").slice(0, 12)}-1234567890@g.us`,
      name: `Style Group ${randomUUID()}`,
      isMonitored: true,
      isActive: true,
    },
  });
  created.groups.push(group.id);
  return group;
}

async function makeReply(accountId: string, groupId: string | null, body: string) {
  return prisma.message.create({
    data: {
      accountId,
      groupId,
      whatsappMessageId: `${randomUUID()}`,
      chatId: "1234567890-1@g.us",
      senderPhone: "8801700000000",
      direction: "OUTGOING",
      body,
      normalizedBody: body,
      timestampWa: new Date(),
      processingStatus: "PROCESSED",
    },
  });
}

beforeEach(async () => {
  await prisma.aiSettings.upsert({
    where: { id: "global" },
    update: { aiEngineEnabled: true, communicationStyleLearningEnabled: true },
    create: { id: "global", aiEngineEnabled: true, communicationStyleLearningEnabled: true },
  });
  await prisma.communicationStyleProfile.upsert({
    where: { id: "global" },
    update: { guidance: null, builtThroughAt: null, humanApproved: false, messagesAnalyzed: 0 },
    create: { id: "global" },
  });
});

afterEach(async () => {
  if (created.accounts.length) {
    await prisma.message.deleteMany({ where: { accountId: { in: created.accounts } } });
    await prisma.whatsAppGroup.deleteMany({ where: { id: { in: created.groups } } });
    await prisma.whatsAppAccount.deleteMany({ where: { id: { in: created.accounts } } });
    created.accounts.length = 0;
    created.groups.length = 0;
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("which replies the style builder reads", () => {
  it("reads replies whose group was never resolved", async () => {
    // The regression. These have groupId NULL and must still count.
    const account = await makeAccount();
    for (let i = 0; i < 30; i++) {
      await makeReply(account.id, null, `Thank you for reaching out about this, reply number ${i}.`);
    }

    const result = await buildCommunicationStyleProfile(stubClient());
    expect(result.ran).toBe(true);
    expect(result.repliesAnalyzed).toBeGreaterThanOrEqual(30);
  });

  it("still excludes the configured notification groups", async () => {
    // The exclusion the NULL fix must not have broken.
    const account = await makeAccount();
    const notifyGroup = await makeGroup(account.id);
    await prisma.automationSettings.upsert({
      where: { id: "global" },
      update: { whatsappNotificationGroupIds: [notifyGroup.whatsappGroupId] },
      create: { id: "global", whatsappNotificationGroupIds: [notifyGroup.whatsappGroupId] },
    });

    for (let i = 0; i < 30; i++) {
      await makeReply(account.id, notifyGroup.id, `Machine written alert number ${i} for the team.`);
    }

    const result = await buildCommunicationStyleProfile(stubClient());
    expect(result.skipped).toBe("NOT_ENOUGH_REPLIES");

    await prisma.automationSettings.update({
      where: { id: "global" },
      data: { whatsappNotificationGroupIds: [] },
    });
  });

  it("does not learn from what the system sent itself", async () => {
    // Learning tone from its own output would tighten a loop around whatever voice it started
    // with, and drift would compound on every rebuild.
    const account = await makeAccount();
    const group = await makeGroup(account.id);

    for (let i = 0; i < 30; i++) {
      const message = await makeReply(account.id, group.id, `Automated reply number ${i} from the assistant.`);
      await prisma.outboundMessage.create({
        data: {
          accountId: account.id,
          chatId: message.chatId,
          toPhone: "8801700000000",
          body: message.body,
          actionType: "AUTO_REPLY",
          idempotencyKey: randomUUID(),
          status: "SENT",
          sentAt: new Date(),
          providerMessageId: message.whatsappMessageId,
        },
      });
    }

    const result = await buildCommunicationStyleProfile(stubClient());
    expect(result.skipped).toBe("NOT_ENOUGH_REPLIES");
  });

  it("stays off entirely until it is switched on", async () => {
    await prisma.aiSettings.update({
      where: { id: "global" },
      data: { communicationStyleLearningEnabled: false },
    });
    const result = await buildCommunicationStyleProfile(stubClient());
    expect(result).toMatchObject({ ran: false, skipped: "STYLE_LEARNING_DISABLED" });
  });

  it("never approves its own output", async () => {
    // The trust boundary: guidance is written, but applies to nothing until a person approves it.
    const account = await makeAccount();
    for (let i = 0; i < 30; i++) {
      await makeReply(account.id, null, `A perfectly ordinary support reply, number ${i}.`);
    }

    await buildCommunicationStyleProfile(stubClient());
    const profile = await prisma.communicationStyleProfile.findUniqueOrThrow({ where: { id: "global" } });
    expect(profile.guidance).toContain("Greet the customer");
    expect(profile.humanApproved).toBe(false);
  });
});
