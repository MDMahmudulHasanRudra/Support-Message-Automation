import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@support-automation/db";
import type { LearningSettings, WhatsAppAccount } from "@prisma/client";
import { getLearningSettings, processOneSegmentationBatch } from "../learning/sessionSegmentation.js";

/**
 * Integration test for Conversation Learning Phase 1 (session segmentation), run against the same
 * shared Postgres instance as every other suite in this directory (see pipeline.integration.test.ts's
 * own doc comment). Deliberately reuses whatever WhatsAppAccount already exists in this dev
 * database rather than creating a new one: a freshly-created account with no sessionId/
 * sessionDataPath would be picked up by the live worker's accountRegistrySync poll within ~20s
 * and provisioned/connected for real — this suite has no need to touch that machinery at all,
 * since segmentation only ever reads/writes Message and ConversationSession rows.
 */

let account: WhatsAppAccount;
let originalLearningSettings: LearningSettings;
const testChatIds: string[] = [];

function uniqueChatId(): string {
  return `${randomUUID().replace(/-/g, "").slice(0, 10)}-9999999999@g.us`;
}

async function createIncomingMessage(params: { chatId: string; senderPhone: string; timestampWa: Date }) {
  return prisma.message.create({
    data: {
      accountId: account.id,
      whatsappMessageId: randomUUID(),
      chatId: params.chatId,
      senderPhone: params.senderPhone,
      direction: "INCOMING",
      body: "test message",
      normalizedBody: "test message",
      timestampWa: params.timestampWa,
      processingStatus: "PROCESSED",
    },
  });
}

async function setLearningSettings(overrides: Partial<LearningSettings>) {
  await prisma.learningSettings.update({ where: { id: "global" }, data: overrides });
}

beforeAll(async () => {
  account = await prisma.whatsAppAccount.findFirstOrThrow();
  originalLearningSettings = await getLearningSettings();
});

afterEach(async () => {
  if (testChatIds.length) {
    await prisma.message.deleteMany({ where: { chatId: { in: testChatIds } } });
    await prisma.conversationSession.deleteMany({ where: { chatId: { in: testChatIds } } });
    testChatIds.length = 0;
  }
  await prisma.learningBatchJob.deleteMany({ where: { jobType: "CONVERSATION_SEGMENTATION" } });
});

afterAll(async () => {
  await prisma.learningSettings.update({ where: { id: "global" }, data: originalLearningSettings });
});

describe("session segmentation — feature disabled (default)", () => {
  it("no-ops entirely: no sessions created, no messages tagged", async () => {
    await setLearningSettings({ conversationLearningEnabled: false });
    const chatId = uniqueChatId();
    testChatIds.push(chatId);
    const message = await createIncomingMessage({ chatId, senderPhone: "+8801111111111", timestampWa: new Date() });

    const didWork = await processOneSegmentationBatch();

    expect(didWork).toBe(false);
    const reloaded = await prisma.message.findUniqueOrThrow({ where: { id: message.id } });
    expect(reloaded.conversationSessionId).toBeNull();
    const sessions = await prisma.conversationSession.findMany({ where: { chatId } });
    expect(sessions).toHaveLength(0);
  });
});

describe("session segmentation — feature enabled", () => {
  it("groups messages within the gap window into one session", async () => {
    await setLearningSettings({ conversationLearningEnabled: true, sessionGapMinutes: 30 });
    const chatId = uniqueChatId();
    testChatIds.push(chatId);
    const base = new Date();
    await createIncomingMessage({ chatId, senderPhone: "+8801111111111", timestampWa: base });
    await createIncomingMessage({ chatId, senderPhone: "+8801111111111", timestampWa: new Date(base.getTime() + 5 * 60_000) });
    await createIncomingMessage({ chatId, senderPhone: "+8802222222222", timestampWa: new Date(base.getTime() + 10 * 60_000) });

    const didWork = await processOneSegmentationBatch();
    expect(didWork).toBe(true);

    const sessions = await prisma.conversationSession.findMany({ where: { chatId } });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.messageCount).toBe(3);
    expect(sessions[0]!.participantPhones.sort()).toEqual(["+8801111111111", "+8802222222222"]);
    expect(sessions[0]!.status).toBe("OPEN");

    const messages = await prisma.message.findMany({ where: { chatId } });
    expect(messages.every((m) => m.conversationSessionId === sessions[0]!.id)).toBe(true);
  });

  it("splits messages separated by more than the gap window into two sessions", async () => {
    await setLearningSettings({ conversationLearningEnabled: true, sessionGapMinutes: 30 });
    const chatId = uniqueChatId();
    testChatIds.push(chatId);
    const base = new Date();
    await createIncomingMessage({ chatId, senderPhone: "+8801111111111", timestampWa: base });
    await createIncomingMessage({ chatId, senderPhone: "+8801111111111", timestampWa: new Date(base.getTime() + 60 * 60_000) });

    await processOneSegmentationBatch();

    const sessions = await prisma.conversationSession.findMany({ where: { chatId }, orderBy: { firstMessageAt: "asc" } });
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.status).toBe("CLOSED");
    expect(sessions[0]!.messageCount).toBe(1);
    expect(sessions[1]!.status).toBe("OPEN");
    expect(sessions[1]!.messageCount).toBe(1);
  });

  it("closes an OPEN session that has gone idle past the gap window even with no new message", async () => {
    await setLearningSettings({ conversationLearningEnabled: true, sessionGapMinutes: 30 });
    const chatId = uniqueChatId();
    testChatIds.push(chatId);
    await createIncomingMessage({ chatId, senderPhone: "+8801111111111", timestampWa: new Date() });
    await processOneSegmentationBatch(); // creates the OPEN session, fresh — not yet idle

    const opened = await prisma.conversationSession.findFirstOrThrow({ where: { chatId } });
    expect(opened.status).toBe("OPEN");

    // Simulate the gap window elapsing with no new message, rather than backdating the
    // triggering message itself (which would make the session idle the instant it's created).
    await prisma.conversationSession.update({
      where: { id: opened.id },
      data: { lastMessageAt: new Date(Date.now() - 60 * 60_000) },
    });

    const didWork = await processOneSegmentationBatch(); // no new messages — only the idle sweep should fire
    expect(didWork).toBe(true);

    const closed = await prisma.conversationSession.findUniqueOrThrow({ where: { id: opened.id } });
    expect(closed.status).toBe("CLOSED");
    expect(closed.closedAt).not.toBeNull();
  });

  it("records a LearningBatchJob audit row for the run", async () => {
    await setLearningSettings({ conversationLearningEnabled: true, sessionGapMinutes: 30 });
    const chatId = uniqueChatId();
    testChatIds.push(chatId);
    await createIncomingMessage({ chatId, senderPhone: "+8801111111111", timestampWa: new Date() });

    await processOneSegmentationBatch();

    const job = await prisma.learningBatchJob.findFirstOrThrow({
      where: { jobType: "CONVERSATION_SEGMENTATION" },
      orderBy: { createdAt: "desc" },
    });
    expect(job.trigger).toBe("SCHEDULED");
    expect(job.status).toBe("COMPLETED");
    expect(job.candidatesConsidered).toBeGreaterThan(0);
  });
});
