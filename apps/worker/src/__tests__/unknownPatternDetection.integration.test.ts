import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@support-automation/db";
import type { AutomationRule, AutomationSettings, LearningSettings, WhatsAppAccount, WhatsAppGroup } from "@prisma/client";
import { processOnePatternDetectionBatch } from "../learning/patternDetectionJob.js";
import { getLearningSettings } from "../learning/sessionSegmentation.js";

/**
 * Integration test for Unknown Pattern Detection. Run against the isolated test database
 * (`pnpm test:isolated` — see README.md's Testing section), never the shared dev/live one — see
 * sessionSegmentation.integration.test.ts's own doc comment for why.
 *
 * Unlike autoApproval.integration.test.ts, this suite never needs to pin the confidence-weight
 * formula: the unknown-pattern floor (patternDetectionJob.ts's rescoreCandidate()) never consults
 * confidenceScore at all — only unhandledCount (evidence rows whose respondingRuleId is null, i.e.
 * no existing AutomationRule fired for that historical message) against the exact same
 * minOccurrenceForCandidate/minDistinctGroupsForCandidate/minDistinctClientsForCandidate floor used
 * for ordinary candidate surfacing.
 *
 * Each test creates and deletes its own isPrimary WhatsApp account (vitest.config.ts sets
 * fileParallelism: false, so this file's tests never race another file's isPrimary account).
 */

let originalLearningSettings: LearningSettings;
let originalWhatsappNotificationGroupIds: string[];
let account: WhatsAppAccount;
const createdGroupIds: string[] = [];
const createdChatIds: string[] = [];
const createdCandidateIds: string[] = [];
const createdRuleIds: string[] = [];

function uniqueChatId(): string {
  return `${randomUUID().replace(/-/g, "").slice(0, 10)}-9999999999@g.us`;
}

function uniqueMarker(): string {
  return `marker${randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

async function makeGroup(): Promise<WhatsAppGroup> {
  const group = await prisma.whatsAppGroup.create({
    data: { accountId: account.id, whatsappGroupId: uniqueChatId(), name: "Test Group", lastSyncedAt: new Date() },
  });
  createdGroupIds.push(group.id);
  return group;
}

/** Creates a CLOSED ConversationSession + its messages, returning the created message ids in
 * order so a test can optionally attach an AutomationExecution to simulate "an existing rule
 * already handled this one" — the exact signal unhandledCount is meant to exclude. */
async function createClosedSession(params: {
  groupId: string;
  messages: Array<{ senderPhone: string; isFromTeamMember: boolean; body: string; timestampWa: Date }>;
}): Promise<{ messageIds: string[] }> {
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

  const messageIds: string[] = [];
  for (const m of params.messages) {
    const message = await prisma.message.create({
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
    messageIds.push(message.id);
  }

  return { messageIds };
}

/** Simulates an existing AutomationRule having already fired for this message (real pipeline
 * behavior, hand-written here since this suite never runs processIncomingMessage itself). */
async function markHandledByRule(messageId: string, rule: AutomationRule): Promise<void> {
  await prisma.automationExecution.create({
    data: {
      messageId,
      ruleId: rule.id,
      actionsExecuted: [],
      decision: "AUTO_REPLY",
      reasonTrace: {},
      idempotencyKey: `test:${messageId}:${rule.id}`,
    },
  });
}

async function makeRule(): Promise<AutomationRule> {
  const rule = await prisma.automationRule.create({
    data: { name: `Unknown Pattern Test Rule ${randomUUID()}`, type: "AUTO_REPLY", matchType: "KEYWORDS" },
  });
  createdRuleIds.push(rule.id);
  return rule;
}

async function setLearningSettings(overrides: Partial<LearningSettings>) {
  await prisma.learningSettings.update({ where: { id: "global" }, data: overrides });
}

beforeAll(async () => {
  originalLearningSettings = await getLearningSettings();
  const automationSettings = await prisma.automationSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
  originalWhatsappNotificationGroupIds = automationSettings.whatsappNotificationGroupIds;
});

beforeEach(async () => {
  account = await prisma.whatsAppAccount.create({
    data: { label: `Unknown Pattern Test ${randomUUID()}`, status: "CONNECTED", isPrimary: true },
  });
  await prisma.automationSettings.update({
    where: { id: "global" },
    data: { whatsappNotificationGroupIds: ["120000000000000000@g.us"] },
  });
});

afterEach(async () => {
  if (createdChatIds.length) {
    await prisma.message.deleteMany({ where: { chatId: { in: createdChatIds } } });
    // PatternCandidateEvidence cascades from ConversationSession's onDelete: Cascade.
    await prisma.conversationSession.deleteMany({ where: { chatId: { in: createdChatIds } } });
    createdChatIds.length = 0;
  }
  if (createdCandidateIds.length) {
    // Notification.relatedPatternCandidateId is onDelete: SetNull, so delete alerts explicitly
    // rather than relying on the candidate delete to clean them up.
    await prisma.notification.deleteMany({ where: { relatedPatternCandidateId: { in: createdCandidateIds } } });
    await prisma.patternCandidate.deleteMany({ where: { id: { in: createdCandidateIds } } });
    createdCandidateIds.length = 0;
  }
  await prisma.patternCandidate.deleteMany({ where: { evidence: { none: {} } } });
  await prisma.learningBatchJob.deleteMany({ where: { jobType: "PATTERN_DETECTION" } });
  if (createdGroupIds.length) {
    await prisma.whatsAppGroup.deleteMany({ where: { id: { in: createdGroupIds } } });
    createdGroupIds.length = 0;
  }
  if (createdRuleIds.length) {
    await prisma.automationExecution.deleteMany({ where: { ruleId: { in: createdRuleIds } } });
    await prisma.automationRule.deleteMany({ where: { id: { in: createdRuleIds } } });
    createdRuleIds.length = 0;
  }
  await prisma.whatsAppAccount.delete({ where: { id: account.id } });
});

afterAll(async () => {
  await prisma.learningSettings.update({ where: { id: "global" }, data: originalLearningSettings });
  await prisma.automationSettings.update({
    where: { id: "global" },
    data: { whatsappNotificationGroupIds: originalWhatsappNotificationGroupIds },
  });
});

describe("unknown pattern detection — disabled (default)", () => {
  it("accumulates unhandledCount but never queues a notification", async () => {
    await setLearningSettings({
      conversationLearningEnabled: true,
      unknownPatternNotificationsEnabled: false,
      minOccurrenceForCandidate: 1,
      minDistinctGroupsForCandidate: 1,
      minDistinctClientsForCandidate: 1,
    });
    const group = await makeGroup();
    const marker = uniqueMarker();
    await createClosedSession({
      groupId: group.id,
      messages: [{ senderPhone: "+8801111111111", isFromTeamMember: false, body: `${marker} internet billing issue`, timestampWa: new Date() }],
    });

    await processOnePatternDetectionBatch();

    const candidate = await prisma.patternCandidate.findFirstOrThrow({ where: { suggestedKeywords: { has: marker } } });
    createdCandidateIds.push(candidate.id);
    expect(candidate.unhandledCount).toBe(1);
    expect(candidate.unknownPatternNotifiedAt).toBeNull();

    const notification = await prisma.notification.findFirst({ where: { relatedPatternCandidateId: candidate.id } });
    expect(notification).toBeNull();
  });
});

describe("unknown pattern detection — enabled", () => {
  it("queues one WhatsApp Notification linked to the candidate once the unhandled floor is cleared", async () => {
    await setLearningSettings({
      conversationLearningEnabled: true,
      unknownPatternNotificationsEnabled: true,
      unknownPatternCooldownMinutes: 60,
      minOccurrenceForCandidate: 1,
      minDistinctGroupsForCandidate: 1,
      minDistinctClientsForCandidate: 1,
    });
    const group = await makeGroup();
    const marker = uniqueMarker();
    await createClosedSession({
      groupId: group.id,
      messages: [{ senderPhone: "+8801111111111", isFromTeamMember: false, body: `${marker} internet billing issue`, timestampWa: new Date() }],
    });

    await processOnePatternDetectionBatch();

    const candidate = await prisma.patternCandidate.findFirstOrThrow({ where: { suggestedKeywords: { has: marker } } });
    createdCandidateIds.push(candidate.id);
    expect(candidate.unhandledCount).toBe(1);
    expect(candidate.unknownPatternNotifiedAt).not.toBeNull();

    const notification = await prisma.notification.findFirstOrThrow({ where: { relatedPatternCandidateId: candidate.id } });
    expect(notification.type).toBe("WHATSAPP");
    expect(notification.accountId).toBe(account.id);
    expect(notification.relatedMessageId).not.toBeNull();
    const payload = notification.payload as Record<string, unknown>;
    expect(payload.alertKind).toBe("UNKNOWN_PATTERN");
    expect(payload.occurrences).toBe(1);
  });

  it("does not count evidence an existing rule already handled, and does not alert on it", async () => {
    await setLearningSettings({
      conversationLearningEnabled: true,
      unknownPatternNotificationsEnabled: true,
      minOccurrenceForCandidate: 1,
      minDistinctGroupsForCandidate: 1,
      minDistinctClientsForCandidate: 1,
    });
    const rule = await makeRule();
    const group = await makeGroup();
    const marker = uniqueMarker();
    const { messageIds } = await createClosedSession({
      groupId: group.id,
      messages: [{ senderPhone: "+8801111111111", isFromTeamMember: false, body: `${marker} internet billing issue`, timestampWa: new Date() }],
    });
    await markHandledByRule(messageIds[0]!, rule);

    await processOnePatternDetectionBatch();

    const candidate = await prisma.patternCandidate.findFirstOrThrow({ where: { suggestedKeywords: { has: marker } } });
    createdCandidateIds.push(candidate.id);
    // The candidate itself still surfaces normally (occurrenceCount clears the floor) — only the
    // unknown-pattern signal is suppressed.
    expect(candidate.occurrenceCount).toBe(1);
    expect(candidate.unhandledCount).toBe(0);
    expect(candidate.unknownPatternNotifiedAt).toBeNull();

    const notification = await prisma.notification.findFirst({ where: { relatedPatternCandidateId: candidate.id } });
    expect(notification).toBeNull();
  });

  it("does not re-alert for the same candidate within the cooldown window", async () => {
    await setLearningSettings({
      conversationLearningEnabled: true,
      unknownPatternNotificationsEnabled: true,
      unknownPatternCooldownMinutes: 60,
      minOccurrenceForCandidate: 1,
      minDistinctGroupsForCandidate: 1,
      minDistinctClientsForCandidate: 1,
    });
    const group = await makeGroup();
    const marker = uniqueMarker();
    await createClosedSession({
      groupId: group.id,
      messages: [{ senderPhone: "+8801111111111", isFromTeamMember: false, body: `${marker} internet billing issue`, timestampWa: new Date() }],
    });
    await processOnePatternDetectionBatch();

    const candidate = await prisma.patternCandidate.findFirstOrThrow({ where: { suggestedKeywords: { has: marker } } });
    createdCandidateIds.push(candidate.id);
    const firstNotifiedAt = candidate.unknownPatternNotifiedAt;
    expect(firstNotifiedAt).not.toBeNull();

    // A second, distinct occurrence of the same pattern arrives before the cooldown elapses. Body
    // text must be identical to the first (not just similar) — derivePatternSignature's keyword
    // set (and therefore patternKey) is sensitive to which distinctive tokens are present, so an
    // extra word here would hash to a different candidate row rather than adding evidence to this one.
    await createClosedSession({
      groupId: group.id,
      messages: [{ senderPhone: "+8802222222222", isFromTeamMember: false, body: `${marker} internet billing issue`, timestampWa: new Date() }],
    });
    await processOnePatternDetectionBatch();

    const notifications = await prisma.notification.findMany({ where: { relatedPatternCandidateId: candidate.id } });
    expect(notifications).toHaveLength(1);

    const refetched = await prisma.patternCandidate.findUniqueOrThrow({ where: { id: candidate.id } });
    expect(refetched.unhandledCount).toBe(2);
    expect(refetched.unknownPatternNotifiedAt?.getTime()).toBe(firstNotifiedAt!.getTime());
  });

  it("never re-alerts once the candidate is APPROVED, REJECTED, MERGED, or EXPIRED", async () => {
    await setLearningSettings({
      conversationLearningEnabled: true,
      unknownPatternNotificationsEnabled: false,
      minOccurrenceForCandidate: 1,
      minDistinctGroupsForCandidate: 1,
      minDistinctClientsForCandidate: 1,
    });
    const group = await makeGroup();
    const marker = uniqueMarker();
    await createClosedSession({
      groupId: group.id,
      messages: [{ senderPhone: "+8801111111111", isFromTeamMember: false, body: `${marker} internet billing issue`, timestampWa: new Date() }],
    });
    await processOnePatternDetectionBatch();

    const candidate = await prisma.patternCandidate.findFirstOrThrow({ where: { suggestedKeywords: { has: marker } } });
    createdCandidateIds.push(candidate.id);
    await prisma.patternCandidate.update({ where: { id: candidate.id }, data: { status: "REJECTED" } });

    // Enable alerts and add one more occurrence of the SAME pattern (identical body text, so it
    // hashes to the same patternKey/candidate row rather than creating a fresh one), making the
    // already-REJECTED candidate "dirty" again.
    await setLearningSettings({ unknownPatternNotificationsEnabled: true });
    await createClosedSession({
      groupId: group.id,
      messages: [{ senderPhone: "+8802222222222", isFromTeamMember: false, body: `${marker} internet billing issue`, timestampWa: new Date() }],
    });
    await processOnePatternDetectionBatch();

    const notification = await prisma.notification.findFirst({ where: { relatedPatternCandidateId: candidate.id } });
    expect(notification).toBeNull();

    const refetched = await prisma.patternCandidate.findUniqueOrThrow({ where: { id: candidate.id } });
    expect(refetched.status).toBe("REJECTED");
    expect(refetched.unknownPatternNotifiedAt).toBeNull();
  });

  it("skips gracefully with no destinations configured, leaving the cooldown clock unset for a later retry", async () => {
    await setLearningSettings({
      conversationLearningEnabled: true,
      unknownPatternNotificationsEnabled: true,
      minOccurrenceForCandidate: 1,
      minDistinctGroupsForCandidate: 1,
      minDistinctClientsForCandidate: 1,
    });
    await prisma.automationSettings.update({ where: { id: "global" }, data: { whatsappNotificationGroupIds: [] } });

    const group = await makeGroup();
    const marker = uniqueMarker();
    await createClosedSession({
      groupId: group.id,
      messages: [{ senderPhone: "+8801111111111", isFromTeamMember: false, body: `${marker} internet billing issue`, timestampWa: new Date() }],
    });

    await processOnePatternDetectionBatch();

    const candidate = await prisma.patternCandidate.findFirstOrThrow({ where: { suggestedKeywords: { has: marker } } });
    createdCandidateIds.push(candidate.id);
    expect(candidate.unhandledCount).toBe(1);
    expect(candidate.unknownPatternNotifiedAt).toBeNull();

    const notification = await prisma.notification.findFirst({ where: { relatedPatternCandidateId: candidate.id } });
    expect(notification).toBeNull();
  });
});
