import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createRuleProposalFromCandidate, prisma } from "@support-automation/db";
import type { AiSettings, LearningSettings, WhatsAppAccount, WhatsAppGroup } from "@prisma/client";
import { processOnePatternDetectionBatch } from "../learning/patternDetectionJob.js";
import { getLearningSettings } from "../learning/sessionSegmentation.js";

/**
 * Integration test for Conversation Learning Phase 6 (auto-approval policy + candidate expiry
 * sweep). Run this against the isolated test database (`pnpm test:isolated` — see README.md's
 * Testing section), never the shared dev/live one — see sessionSegmentation.integration.test.ts's
 * own doc comment for why.
 *
 * Every scenario here pins weightFrequency=100 and every other weight to 0, so a candidate's
 * confidenceScore reduces to exactly scoreFrequency(occurrenceCount, minOccurrenceForCandidate) —
 * see packages/engine/src/patternDetection.test.ts for that formula. With
 * minOccurrenceForCandidate=1: 2 occurrences -> frequencyScore 79, 4 occurrences -> frequencyScore
 * 100 (clamped). This lets each test target a precise confidence score by choosing how many
 * closed sessions to create, instead of depending on the full six-signal blend.
 */

let account: WhatsAppAccount;
let originalLearningSettings: LearningSettings;
let originalHumanReviewThreshold: number;
const createdGroupIds: string[] = [];
const createdChatIds: string[] = [];
const createdCandidateIds: string[] = [];

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

/** Pins the confidence formula to pure frequency, per this file's doc comment. */
const FREQUENCY_ONLY_WEIGHTS: Partial<LearningSettings> = {
  weightFrequency: 100,
  weightDiversity: 0,
  weightConsistency: 0,
  weightResolution: 0,
  weightRecency: 0,
  weightAiConfidence: 0,
  minOccurrenceForCandidate: 1,
  minDistinctGroupsForCandidate: 1,
  minDistinctClientsForCandidate: 1,
};

/** A single alphanumeric token — patternDetection's tokenizer splits on any non-letter/non-number
 * character, so a marker containing a hyphen (e.g. randomUUID()'s default form) would never survive
 * as one matchable keyword. */
function uniqueMarker(): string {
  return `marker${randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

/** Creates `count` closed sessions all sharing one distinctive keyword, so occurrenceCount == count. */
async function seedOccurrences(count: number, marker: string, group: WhatsAppGroup): Promise<void> {
  for (let i = 0; i < count; i++) {
    await createClosedSession({
      groupId: group.id,
      messages: [
        {
          senderPhone: "+8801111111111",
          isFromTeamMember: false,
          body: `${marker} billing question about invoice`,
          timestampWa: new Date(),
        },
      ],
    });
  }
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
  if (createdCandidateIds.length) {
    // RuleProposal cascades from PatternCandidate's onDelete: Cascade; the created AutomationRule
    // (if any) only has its createdRuleId set SetNull, so it's cleaned up separately below.
    const proposals = await prisma.ruleProposal.findMany({ where: { patternCandidateId: { in: createdCandidateIds } } });
    const ruleIds = proposals.map((p) => p.createdRuleId).filter((v): v is string => Boolean(v));
    await prisma.patternCandidate.deleteMany({ where: { id: { in: createdCandidateIds } } });
    if (ruleIds.length) await prisma.automationRule.deleteMany({ where: { id: { in: ruleIds } } });
    createdCandidateIds.length = 0;
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

describe("auto-approval — disabled (default)", () => {
  it("a candidate that clears the human-review bar stays PENDING_REVIEW; no proposal or rule is created", async () => {
    await setLearningSettings({ conversationLearningEnabled: true, autoApprovalEnabled: false, ...FREQUENCY_ONLY_WEIGHTS });
    await prisma.aiSettings.update({ where: { id: "global" }, data: { humanReviewThreshold: 60 } });

    const group = await makeGroup();
    const marker = uniqueMarker();
    await seedOccurrences(4, marker, group); // frequencyScore 100 -> confidence 100

    await processOnePatternDetectionBatch();

    const candidate = await prisma.patternCandidate.findFirstOrThrow({ where: { suggestedKeywords: { has: marker } } });
    createdCandidateIds.push(candidate.id);
    expect(candidate.confidenceScore).toBe(100);
    expect(candidate.status).toBe("PENDING_REVIEW");

    const proposal = await prisma.ruleProposal.findUnique({ where: { patternCandidateId: candidate.id } });
    expect(proposal).toBeNull();
  });
});

describe("auto-approval — enabled", () => {
  it("a candidate at/above autoApprovalMinConfidence is auto-approved into a real, DRAFT AutomationRule", async () => {
    await setLearningSettings({
      conversationLearningEnabled: true,
      autoApprovalEnabled: true,
      autoApprovalMinConfidence: 90,
      ...FREQUENCY_ONLY_WEIGHTS,
    });
    await prisma.aiSettings.update({ where: { id: "global" }, data: { humanReviewThreshold: 60 } });

    const group = await makeGroup();
    const marker = uniqueMarker();
    await seedOccurrences(4, marker, group); // frequencyScore 100 -> confidence 100 >= 90

    await processOnePatternDetectionBatch();

    const candidate = await prisma.patternCandidate.findFirstOrThrow({ where: { suggestedKeywords: { has: marker } } });
    createdCandidateIds.push(candidate.id);
    expect(candidate.status).toBe("APPROVED");

    const proposal = await prisma.ruleProposal.findUniqueOrThrow({ where: { patternCandidateId: candidate.id } });
    expect(proposal.status).toBe("APPROVED");
    expect(proposal.autoApproved).toBe(true);
    expect(proposal.reviewedById).toBeNull();
    expect(proposal.createdRuleId).not.toBeNull();

    const rule = await prisma.automationRule.findUniqueOrThrow({ where: { id: proposal.createdRuleId! } });
    expect(rule.status).toBe("DRAFT");
  });

  it("a candidate that clears human-review but not autoApprovalMinConfidence stays PENDING_REVIEW", async () => {
    await setLearningSettings({
      conversationLearningEnabled: true,
      autoApprovalEnabled: true,
      autoApprovalMinConfidence: 90,
      ...FREQUENCY_ONLY_WEIGHTS,
    });
    await prisma.aiSettings.update({ where: { id: "global" }, data: { humanReviewThreshold: 60 } });

    const group = await makeGroup();
    const marker = uniqueMarker();
    await seedOccurrences(2, marker, group); // frequencyScore 79 -> confidence 79: >=60, <90

    await processOnePatternDetectionBatch();

    const candidate = await prisma.patternCandidate.findFirstOrThrow({ where: { suggestedKeywords: { has: marker } } });
    createdCandidateIds.push(candidate.id);
    expect(candidate.confidenceScore).toBe(79);
    expect(candidate.status).toBe("PENDING_REVIEW");

    const proposal = await prisma.ruleProposal.findUnique({ where: { patternCandidateId: candidate.id } });
    expect(proposal).toBeNull();
  });

  it("does not duplicate or crash when a human already created a proposal for the candidate", async () => {
    await setLearningSettings({
      conversationLearningEnabled: true,
      autoApprovalEnabled: false,
      autoApprovalMinConfidence: 90,
      ...FREQUENCY_ONLY_WEIGHTS,
    });
    await prisma.aiSettings.update({ where: { id: "global" }, data: { humanReviewThreshold: 60 } });

    const group = await makeGroup();
    const marker = uniqueMarker();
    await seedOccurrences(4, marker, group);
    await processOnePatternDetectionBatch();

    const candidate = await prisma.patternCandidate.findFirstOrThrow({ where: { suggestedKeywords: { has: marker } } });
    createdCandidateIds.push(candidate.id);
    expect(candidate.status).toBe("PENDING_REVIEW");

    const manualProposal = await createRuleProposalFromCandidate(candidate.id);
    if (!("id" in manualProposal)) throw new Error(`expected proposal creation to succeed: ${manualProposal.error}`);

    // A new occurrence makes the candidate "dirty" again on the next tick; flipping auto-approval
    // on afterwards must not crash or create a second proposal now that one already exists.
    await setLearningSettings({ autoApprovalEnabled: true, autoApprovalMinConfidence: 90 });
    await seedOccurrences(1, marker, group);
    await processOnePatternDetectionBatch();

    const proposals = await prisma.ruleProposal.findMany({ where: { patternCandidateId: candidate.id } });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.status).toBe("PENDING_REVIEW");

    const refetched = await prisma.patternCandidate.findUniqueOrThrow({ where: { id: candidate.id } });
    expect(refetched.status).toBe("PENDING_REVIEW");
  });
});

describe("candidate expiry sweep", () => {
  it("moves a PENDING_REVIEW candidate untouched past candidateExpiryDays into EXPIRED", async () => {
    await setLearningSettings({ conversationLearningEnabled: true, candidateExpiryDays: 30 });

    const staleDate = new Date(Date.now() - 40 * 24 * 60 * 60_000);
    const candidate = await prisma.patternCandidate.create({
      data: {
        patternKey: `expiry-test-${randomUUID()}`,
        suggestedMatchType: "KEYWORDS",
        suggestedKeywords: ["expiry", "test"],
        firstSeenAt: staleDate,
        lastSeenAt: staleDate,
        status: "PENDING_REVIEW",
        updatedAt: staleDate,
      },
    });
    createdCandidateIds.push(candidate.id);

    await processOnePatternDetectionBatch();

    const refetched = await prisma.patternCandidate.findUniqueOrThrow({ where: { id: candidate.id } });
    expect(refetched.status).toBe("EXPIRED");
  });

  it("leaves a recently-updated PENDING_REVIEW candidate alone", async () => {
    await setLearningSettings({ conversationLearningEnabled: true, candidateExpiryDays: 30 });

    const candidate = await prisma.patternCandidate.create({
      data: {
        patternKey: `expiry-fresh-test-${randomUUID()}`,
        suggestedMatchType: "KEYWORDS",
        suggestedKeywords: ["expiry", "fresh"],
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        status: "PENDING_REVIEW",
      },
    });
    createdCandidateIds.push(candidate.id);

    await processOnePatternDetectionBatch();

    const refetched = await prisma.patternCandidate.findUniqueOrThrow({ where: { id: candidate.id } });
    expect(refetched.status).toBe("PENDING_REVIEW");
  });
});
