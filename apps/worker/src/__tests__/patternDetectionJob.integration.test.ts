import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@support-automation/db";
import type { AiSettings, LearningSettings, WhatsAppAccount, WhatsAppGroup } from "@prisma/client";
import { processOnePatternDetectionBatch } from "../learning/patternDetectionJob.js";
import { getLearningSettings } from "../learning/sessionSegmentation.js";

/**
 * Integration test for Conversation Learning Phase 2 (deterministic pattern detection). Run this
 * against the isolated test database (`pnpm test:isolated` — see README.md's Testing section),
 * never the shared dev/live one — see sessionSegmentation.integration.test.ts's own doc comment
 * for why. Sessions are built directly (not via the segmentation job, which already has its own
 * dedicated test suite) so this suite can isolate detection logic.
 */

let account: WhatsAppAccount;
let originalLearningSettings: LearningSettings;
let originalHumanReviewThreshold: number;
const createdGroupIds: string[] = [];
const createdChatIds: string[] = [];

function uniqueChatId(): string {
  return `${randomUUID().replace(/-/g, "").slice(0, 10)}-9999999999@g.us`;
}

async function makeGroup(): Promise<WhatsAppGroup> {
  const group = await prisma.whatsAppGroup.create({
    data: { accountId: account.id, whatsappGroupId: uniqueChatId(), name: "Test Group", lastSyncedAt: new Date() },
  });
  createdGroupIds.push(group.id);
  return group;
}

/** Creates a CLOSED ConversationSession directly with its messages already tagged — bypasses the segmentation job entirely. */
async function createClosedSession(params: {
  groupId: string;
  messages: Array<{ senderPhone: string; isFromTeamMember: boolean; body: string; timestampWa: Date }>;
}) {
  const chatId = uniqueChatId();
  createdChatIds.push(chatId);
  const first = params.messages[0]!.timestampWa;
  const last = params.messages[params.messages.length - 1]!.timestampWa;

  const session = await prisma.conversationSession.create({
    data: {
      accountId: account.id,
      chatId,
      groupId: params.groupId,
      status: "CLOSED",
      firstMessageAt: first,
      lastMessageAt: last,
      closedAt: last,
      messageCount: params.messages.length,
    },
  });

  for (const m of params.messages) {
    await prisma.message.create({
      data: {
        accountId: account.id,
        groupId: params.groupId,
        conversationSessionId: session.id,
        whatsappMessageId: randomUUID(),
        chatId,
        senderPhone: m.senderPhone,
        isFromTeamMember: m.isFromTeamMember,
        direction: "INCOMING",
        body: m.body,
        normalizedBody: m.body.toLowerCase(),
        timestampWa: m.timestampWa,
        processingStatus: "PROCESSED",
      },
    });
  }

  return session;
}

async function setLearningSettings(overrides: Partial<LearningSettings>) {
  await prisma.learningSettings.update({ where: { id: "global" }, data: overrides });
}

beforeAll(async () => {
  account =
    (await prisma.whatsAppAccount.findFirst()) ??
    (await prisma.whatsAppAccount.create({ data: { label: "Test Account (isolated DB fallback)", status: "CONNECTED" } }));
  originalLearningSettings = await getLearningSettings();
  const aiSettings: AiSettings = await prisma.aiSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
  originalHumanReviewThreshold = aiSettings.humanReviewThreshold;
});

afterEach(async () => {
  if (createdChatIds.length) {
    await prisma.message.deleteMany({ where: { chatId: { in: createdChatIds } } });
    // PatternCandidateEvidence cascades from ConversationSession's onDelete: Cascade.
    await prisma.conversationSession.deleteMany({ where: { chatId: { in: createdChatIds } } });
    createdChatIds.length = 0;
  }
  await prisma.patternCandidate.deleteMany({ where: { evidence: { none: {} } } });
  await prisma.learningBatchJob.deleteMany({ where: { jobType: "PATTERN_DETECTION" } });
  if (createdGroupIds.length) {
    await prisma.whatsAppGroup.deleteMany({ where: { id: { in: createdGroupIds } } });
    createdGroupIds.length = 0;
  }
});

afterAll(async () => {
  await prisma.learningSettings.update({ where: { id: "global" }, data: originalLearningSettings });
  await prisma.aiSettings.update({ where: { id: "global" }, data: { humanReviewThreshold: originalHumanReviewThreshold } });
});

describe("pattern detection — feature disabled (default)", () => {
  it("no-ops entirely: no candidates created", async () => {
    await setLearningSettings({ conversationLearningEnabled: false });
    const group = await makeGroup();
    await createClosedSession({
      groupId: group.id,
      messages: [{ senderPhone: "+8801111111111", isFromTeamMember: false, body: "internet is slow today", timestampWa: new Date() }],
    });

    const didWork = await processOnePatternDetectionBatch();
    expect(didWork).toBe(false);
  });
});

describe("pattern detection — feature enabled", () => {
  it("creates an accumulator row below the floor but never advances it past PENDING_ANALYSIS", async () => {
    await setLearningSettings({
      conversationLearningEnabled: true,
      minOccurrenceForCandidate: 3,
      minDistinctGroupsForCandidate: 2,
      minDistinctClientsForCandidate: 2,
    });
    const group = await makeGroup();
    await createClosedSession({
      groupId: group.id,
      messages: [{ senderPhone: "+8801111111111", isFromTeamMember: false, body: "internet connection speed problem", timestampWa: new Date() }],
    });

    await processOnePatternDetectionBatch();

    const candidate = await prisma.patternCandidate.findFirstOrThrow({
      where: { suggestedKeywords: { hasSome: ["internet", "connection"] } },
    });
    expect(candidate.occurrenceCount).toBe(1);
    expect(candidate.status).toBe("PENDING_ANALYSIS");
  });

  it("advances to PENDING_REVIEW once the occurrence/diversity floor and confidence threshold are both cleared", async () => {
    await setLearningSettings({
      conversationLearningEnabled: true,
      minOccurrenceForCandidate: 2,
      minDistinctGroupsForCandidate: 2,
      minDistinctClientsForCandidate: 2,
    });
    // Low enough that this scenario's blended score (moderate frequency/diversity/consistency,
    // no AI having run) reliably clears it — see patternDetection.test.ts for the scoring shape.
    await prisma.aiSettings.update({ where: { id: "global" }, data: { humanReviewThreshold: 40 } });

    const groupA = await makeGroup();
    const groupB = await makeGroup();
    const now = new Date();

    await createClosedSession({
      groupId: groupA.id,
      messages: [
        { senderPhone: "+8801111111111", isFromTeamMember: false, body: "internet connection speed problem", timestampWa: now },
        { senderPhone: "+8809999999999", isFromTeamMember: true, body: "please restart your router", timestampWa: new Date(now.getTime() + 60_000) },
      ],
    });
    await createClosedSession({
      groupId: groupB.id,
      messages: [
        { senderPhone: "+8802222222222", isFromTeamMember: false, body: "internet connection speed problem", timestampWa: now },
      ],
    });

    await processOnePatternDetectionBatch();

    const candidate = await prisma.patternCandidate.findFirstOrThrow({
      where: { suggestedKeywords: { hasSome: ["internet", "connection"] } },
    });
    expect(candidate.occurrenceCount).toBe(2);
    expect(candidate.distinctGroupCount).toBe(2);
    expect(candidate.distinctClientCount).toBe(2);
    expect(candidate.status).toBe("PENDING_REVIEW");
    expect(candidate.suggestedReplyMessage).toBe("please restart your router");
  });

  it("skips a session whose messages are entirely from team members (no customer message to derive a signature from)", async () => {
    await setLearningSettings({ conversationLearningEnabled: true, minOccurrenceForCandidate: 1, minDistinctGroupsForCandidate: 1, minDistinctClientsForCandidate: 1 });
    const group = await makeGroup();
    await createClosedSession({
      groupId: group.id,
      messages: [{ senderPhone: "+8809999999999", isFromTeamMember: true, body: "staff-only coordination message", timestampWa: new Date() }],
    });

    await processOnePatternDetectionBatch();

    const candidates = await prisma.patternCandidate.findMany({
      where: { suggestedKeywords: { hasSome: ["staff", "coordination"] } },
    });
    expect(candidates).toHaveLength(0);
  });

  it("records a LearningBatchJob audit row for the run", async () => {
    await setLearningSettings({ conversationLearningEnabled: true, minOccurrenceForCandidate: 1, minDistinctGroupsForCandidate: 1, minDistinctClientsForCandidate: 1 });
    const group = await makeGroup();
    await createClosedSession({
      groupId: group.id,
      messages: [{ senderPhone: "+8801111111111", isFromTeamMember: false, body: "payment failed retry", timestampWa: new Date() }],
    });

    await processOnePatternDetectionBatch();

    const job = await prisma.learningBatchJob.findFirstOrThrow({
      where: { jobType: "PATTERN_DETECTION" },
      orderBy: { createdAt: "desc" },
    });
    expect(job.trigger).toBe("SCHEDULED");
    expect(job.status).toBe("COMPLETED");
    expect(job.candidatesConsidered).toBeGreaterThan(0);
  });
});
