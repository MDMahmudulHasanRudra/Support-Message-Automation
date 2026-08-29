import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomInt, randomUUID } from "node:crypto";
import { prisma } from "@support-automation/db";
import type { AiSettings, LearningSettings, WhatsAppAccount, WhatsAppGroup } from "@prisma/client";
import { processOneAiAnalysisBatch, parseAnalysisResponse } from "../learning/aiAnalysisJob.js";
import { processOnePatternDetectionBatch } from "../learning/patternDetectionJob.js";
import { getLearningSettings } from "../learning/sessionSegmentation.js";
import { MockAiClient } from "./mockAiClient.js";

/**
 * Integration tests for Conversation Learning Phase 5 (AI-assisted batch analysis), run against
 * the same shared Postgres instance as every other suite in this directory. Uses MockAiClient
 * (see mockAiClient.ts) injected via processOneAiAnalysisBatch()'s test-only `clientOverride`
 * parameter — never a real API key, never a real network call, per this repo's test-group/testing
 * policy of preferring mocks over real external calls wherever possible.
 *
 * Candidates-with-evidence are built via the real, already-tested deterministic pipeline
 * (createClosedSession + processOnePatternDetectionBatch) rather than hand-rolled
 * PatternCandidateEvidence rows — rescoreCandidate() recomputes everything from real evidence and
 * early-returns with none, so a bare PatternCandidate row (no evidence) can't exercise the actual
 * scoring/status-transition path this suite needs to verify.
 */

let originalLearningSettings: LearningSettings;
let originalAiSettings: AiSettings;
let account: WhatsAppAccount;
const createdGroupIds: string[] = [];
const createdChatIds: string[] = [];
const createdCandidateIds: string[] = [];

const PHONE_RUN_PREFIX = String(randomInt(100_000, 999_999));
let phoneSequence = 0;

function uniquePhone(): string {
  // Digits only, and unique within this file's run. This used to slice a UUID, which is
  // hex: team-member matching normalizes a number to its digits, so "+8809a3f2b1c4" became
  // "88093214" — sometimes under the 8-digit minimum, making the seeded member unresolvable
  // and failing whichever test happened to draw it. Roughly one call in seven.
  return `+8809${PHONE_RUN_PREFIX}${String(++phoneSequence).padStart(4, "0")}`;
}

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

async function createClosedSession(params: { groupId: string; senderPhone: string; body: string; timestampWa: Date }) {
  const chatId = uniqueChatId();
  createdChatIds.push(chatId);

  const session = await prisma.conversationSession.create({
    data: {
      accountId: account.id,
      chatId,
      groupId: params.groupId,
      status: "CLOSED",
      firstMessageAt: params.timestampWa,
      lastMessageAt: params.timestampWa,
      closedAt: params.timestampWa,
      messageCount: 1,
    },
  });

  await prisma.message.create({
    data: {
      accountId: account.id,
      groupId: params.groupId,
      conversationSessionId: session.id,
      whatsappMessageId: randomUUID(),
      chatId,
      senderPhone: params.senderPhone,
      isFromTeamMember: false,
      direction: "INCOMING",
      body: params.body,
      normalizedBody: params.body.toLowerCase(),
      timestampWa: params.timestampWa,
      processingStatus: "PROCESSED",
    },
  });

  return session;
}

/**
 * Seeds 3 real, evidence-backed sessions across 2 groups and 3 distinct clients, then runs the
 * real deterministic detection job to produce a genuine floor-clearing PatternCandidate. `marker`
 * distinguishes the pattern signature between calls in the same test (same wording would upsert
 * onto the same existing PatternCandidate row instead of creating a second, distinct one).
 */
async function seedFloorClearingCandidate(marker = "connection") {
  const groupA = await makeGroup();
  const groupB = await makeGroup();
  const now = new Date();
  const body = `internet ${marker} speed problem`;

  await createClosedSession({ groupId: groupA.id, senderPhone: uniquePhone(), body, timestampWa: now });
  await createClosedSession({ groupId: groupB.id, senderPhone: uniquePhone(), body, timestampWa: now });
  await createClosedSession({ groupId: groupA.id, senderPhone: uniquePhone(), body, timestampWa: now });

  await processOnePatternDetectionBatch();

  const candidate = await prisma.patternCandidate.findFirstOrThrow({
    where: { suggestedKeywords: { has: marker } },
  });
  createdCandidateIds.push(candidate.id);
  return candidate;
}

async function enableAi(overrides: Partial<AiSettings> = {}) {
  await prisma.aiSettings.update({
    where: { id: "global" },
    data: { aiEngineEnabled: true, learningEnabled: true, humanReviewThreshold: 70, ...overrides },
  });
  await prisma.learningSettings.update({
    where: { id: "global" },
    data: {
      conversationLearningEnabled: true,
      minOccurrenceForCandidate: 3,
      minDistinctGroupsForCandidate: 2,
      minDistinctClientsForCandidate: 3,
    },
  });
}

beforeAll(async () => {
  originalLearningSettings = await getLearningSettings();
  originalAiSettings = await prisma.aiSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
  account = await prisma.whatsAppAccount.create({ data: { label: `AI Analysis Test ${randomUUID()}`, status: "CONNECTED" } });
});

afterEach(async () => {
  await prisma.learningBatchJob.deleteMany({ where: { jobType: { in: ["AI_ANALYSIS", "PATTERN_DETECTION"] } } });
  if (createdCandidateIds.length) {
    await prisma.patternCandidate.deleteMany({ where: { id: { in: createdCandidateIds } } }); // cascades PatternCandidateEvidence
    createdCandidateIds.length = 0;
  }
  if (createdChatIds.length) {
    await prisma.message.deleteMany({ where: { chatId: { in: createdChatIds } } });
    await prisma.conversationSession.deleteMany({ where: { chatId: { in: createdChatIds } } });
    createdChatIds.length = 0;
  }
  if (createdGroupIds.length) {
    await prisma.whatsAppGroup.deleteMany({ where: { id: { in: createdGroupIds } } });
    createdGroupIds.length = 0;
  }
});

afterAll(async () => {
  await prisma.learningSettings.update({ where: { id: "global" }, data: originalLearningSettings });
  await prisma.aiSettings.update({ where: { id: "global" }, data: originalAiSettings });
  await prisma.whatsAppAccount.delete({ where: { id: account.id } });
});

describe("parseAnalysisResponse", () => {
  it("parses a well-formed response", () => {
    const result = parseAnalysisResponse("CONFIDENCE: 78\nSUMMARY: A coherent, reusable pattern.");
    expect(result.confidence).toBe(78);
    expect(result.summary).toBe("A coherent, reusable pattern.");
  });

  it("clamps an out-of-range confidence value", () => {
    expect(parseAnalysisResponse("CONFIDENCE: 150\nSUMMARY: x").confidence).toBe(100);
    expect(parseAnalysisResponse("CONFIDENCE: -5\nSUMMARY: x").confidence).toBe(0);
  });

  it("returns null confidence when the AI didn't follow the requested format", () => {
    const result = parseAnalysisResponse("I think this is a good pattern, roughly 80% confident.");
    expect(result.confidence).toBeNull();
    expect(result.summary.length).toBeGreaterThan(0);
  });
});

describe("processOneAiAnalysisBatch — AI disabled (default)", () => {
  it("no-ops entirely, never touches any candidate", async () => {
    // Conversation learning itself must stay ON so the fixture-seeding pattern-detection call can
    // actually produce a real candidate — it's specifically AI (aiEngineEnabled/learningEnabled)
    // this test leaves off.
    await prisma.learningSettings.update({
      where: { id: "global" },
      data: {
        conversationLearningEnabled: true,
        minOccurrenceForCandidate: 3,
        minDistinctGroupsForCandidate: 2,
        minDistinctClientsForCandidate: 3,
      },
    });
    await prisma.aiSettings.update({ where: { id: "global" }, data: { aiEngineEnabled: false, learningEnabled: false } });
    const candidate = await seedFloorClearingCandidate();

    const didWork = await processOneAiAnalysisBatch("MANUAL", new MockAiClient());

    expect(didWork).toBe(false);
    const reloaded = await prisma.patternCandidate.findUniqueOrThrow({ where: { id: candidate.id } });
    expect(reloaded.status).toBe("PENDING_ANALYSIS");
    expect(reloaded.aiConfidenceScore).toBeNull();
  });
});

describe("processOneAiAnalysisBatch — AI enabled (via injected MockAiClient)", () => {
  it("skips a candidate that hasn't cleared the deterministic floor yet", async () => {
    await enableAi();
    // A single below-floor accumulator, created directly (never goes through detection linking).
    const candidate = await prisma.patternCandidate.create({
      data: {
        patternKey: `test-${randomUUID()}`,
        suggestedMatchType: "KEYWORDS",
        suggestedKeywords: ["payment", "failed"],
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        occurrenceCount: 1,
        distinctGroupCount: 1,
        distinctClientCount: 1,
        status: "PENDING_ANALYSIS",
      },
    });
    createdCandidateIds.push(candidate.id);
    const client = new MockAiClient();

    await processOneAiAnalysisBatch("MANUAL", client);

    expect(client.requests).toHaveLength(0);
    const reloaded = await prisma.patternCandidate.findUniqueOrThrow({ where: { id: candidate.id } });
    expect(reloaded.status).toBe("PENDING_ANALYSIS");
    expect(reloaded.aiConfidenceScore).toBeNull();
  });

  it("analyzes a floor-clearing candidate and marks it ANALYZED when the blended score doesn't clear the review threshold", async () => {
    await enableAi({ humanReviewThreshold: 99 });
    const candidate = await seedFloorClearingCandidate();
    const client = new MockAiClient();
    client.nextText = "CONFIDENCE: 40\nSUMMARY: Somewhat plausible but not strongly consistent.";

    const didWork = await processOneAiAnalysisBatch("MANUAL", client);

    expect(didWork).toBe(true);
    expect(client.requests).toHaveLength(1);
    const reloaded = await prisma.patternCandidate.findUniqueOrThrow({ where: { id: candidate.id } });
    expect(reloaded.aiConfidenceScore).toBe(40);
    expect(reloaded.aiAnalysisSummary).toContain("Somewhat plausible");
    expect(reloaded.status).toBe("ANALYZED");
  });

  it("promotes a floor-clearing candidate straight to PENDING_REVIEW when the blended score clears the threshold", async () => {
    await enableAi({ humanReviewThreshold: 10 }); // low bar so a high AI score reliably clears the blend
    const candidate = await seedFloorClearingCandidate();
    const client = new MockAiClient();
    client.nextText = "CONFIDENCE: 95\nSUMMARY: Highly consistent, clearly a reusable support pattern.";

    await processOneAiAnalysisBatch("MANUAL", client);

    const reloaded = await prisma.patternCandidate.findUniqueOrThrow({ where: { id: candidate.id } });
    expect(reloaded.status).toBe("PENDING_REVIEW");
  });

  it("never re-selects a candidate that's already been analyzed", async () => {
    await enableAi({ humanReviewThreshold: 99 });
    const candidate = await seedFloorClearingCandidate();
    await prisma.patternCandidate.update({ where: { id: candidate.id }, data: { status: "ANALYZED", aiConfidenceScore: 50 } });
    const client = new MockAiClient();

    const didWork = await processOneAiAnalysisBatch("MANUAL", client);

    expect(didWork).toBe(false);
    expect(client.requests).toHaveLength(0);
    const reloaded = await prisma.patternCandidate.findUniqueOrThrow({ where: { id: candidate.id } });
    expect(reloaded.aiConfidenceScore).toBe(50); // untouched
  });

  it("one candidate's malformed AI response doesn't abort the rest of the batch", async () => {
    await enableAi({ humanReviewThreshold: 99 });
    const first = await seedFloorClearingCandidate("connection");
    const second = await seedFloorClearingCandidate("bandwidth");
    const client = new MockAiClient();
    client.queuedTexts = ["not in the requested format at all", "CONFIDENCE: 60\nSUMMARY: Reasonable pattern."];

    const didWork = await processOneAiAnalysisBatch("MANUAL", client);

    expect(didWork).toBe(true);
    expect(client.requests).toHaveLength(2);
    const reloadedFirst = await prisma.patternCandidate.findUniqueOrThrow({ where: { id: first.id } });
    const reloadedSecond = await prisma.patternCandidate.findUniqueOrThrow({ where: { id: second.id } });
    const results = [reloadedFirst, reloadedSecond];
    expect(results.some((r) => r.aiConfidenceScore === null && r.aiAnalysisSummary)).toBe(true);
    expect(results.some((r) => r.aiConfidenceScore === 60)).toBe(true);
    expect(results.every((r) => r.status === "ANALYZED")).toBe(true);
  });

  it("records a LearningBatchJob audit row for the run", async () => {
    await enableAi({ humanReviewThreshold: 99 });
    await seedFloorClearingCandidate();
    const client = new MockAiClient();

    await processOneAiAnalysisBatch("MANUAL", client);

    const job = await prisma.learningBatchJob.findFirstOrThrow({
      where: { jobType: "AI_ANALYSIS" },
      orderBy: { createdAt: "desc" },
    });
    expect(job.trigger).toBe("MANUAL");
    expect(job.status).toBe("COMPLETED");
    expect(job.candidatesConsidered).toBe(1);
    expect(job.candidatesUpdated).toBe(1);
  });
});
