import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma, createRuleProposalFromCandidate, approveRuleProposalById } from "@support-automation/db";
import type { AiSettings, AutomationSettings, LearningSettings, Prisma, WhatsAppAccount, WhatsAppGroup } from "@prisma/client";
import { processIncomingMessage } from "../pipeline/processIncomingMessage.js";
import { processOnePatternDetectionBatch } from "../learning/patternDetectionJob.js";
import { getLearningSettings } from "../learning/sessionSegmentation.js";
import { MockAiClient } from "./mockAiClient.js";

/**
 * End-to-end proof of the Hybrid AI Automation cost-reduction loop (Slice 2): a recurring pattern
 * the AI fallback layer handles becomes real Conversation Learning evidence, clears the existing
 * occurrence/diversity floor, becomes a Rule Proposal, and once a human approves + activates it,
 * the deterministic rule engine handles every future matching message — AI is never called again
 * for that pattern. Every step reuses real, unmodified production functions
 * (processIncomingMessage, processOnePatternDetectionBatch, createRuleProposalFromCandidate,
 * approveRuleProposalById); the only hand-built step is linking each message into its own CLOSED
 * ConversationSession, mirroring patternDetectionJob.integration.test.ts's own
 * bypass-segmentation convention (the real 5-minute segmentation job is covered by its own suite).
 */

let originalAutomationSettings: AutomationSettings;
let originalAiSettings: AiSettings;
let originalLearningSettings: LearningSettings;
let preExistingActiveRuleIds: string[] = [];
let account: WhatsAppAccount;
const createdGroupIds: string[] = [];
const createdCandidateIds: string[] = [];
const createdRuleIds: string[] = [];

function uniquePhone(): string {
  return `+8809${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

function uniqueGroupJid(): string {
  return `${randomUUID().replace(/-/g, "").slice(0, 10)}-9999999999@g.us`;
}

async function resetAutomationSettings(overrides: Partial<Prisma.AutomationSettingsUpdateInput> = {}) {
  await prisma.automationSettings.update({
    where: { id: "global" },
    data: {
      automationEnabled: true,
      mode: "SAFE_AUTO_REPLY",
      rateLimitingEnabled: false,
      defaultReplyDelayMinMs: 0,
      defaultReplyDelayMaxMs: 0,
      ...overrides,
    },
  });
}

async function makeEligibleGroup(): Promise<WhatsAppGroup> {
  const group = await prisma.whatsAppGroup.create({
    data: {
      accountId: account.id,
      whatsappGroupId: uniqueGroupJid(),
      name: "AI Cost Reduction Test Group",
      isMonitored: true,
      aiAutomationEnabled: true,
      lastSyncedAt: new Date(),
    },
  });
  createdGroupIds.push(group.id);
  return group;
}

/** Links a real, already-persisted message into its own CLOSED session — bypasses the 5-minute
 * segmentation job (already covered by sessionSegmentation.integration.test.ts) so this test can
 * move straight to pattern detection. */
async function closeMessageIntoOwnSession(message: { id: string; accountId: string; groupId: string | null; chatId: string; timestampWa: Date }) {
  const session = await prisma.conversationSession.create({
    data: {
      accountId: message.accountId,
      chatId: message.chatId,
      groupId: message.groupId,
      status: "CLOSED",
      firstMessageAt: message.timestampWa,
      lastMessageAt: message.timestampWa,
      closedAt: message.timestampWa,
      messageCount: 1,
    },
  });
  await prisma.message.update({ where: { id: message.id }, data: { conversationSessionId: session.id } });
  return session;
}

beforeAll(async () => {
  originalAutomationSettings = await prisma.automationSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
  originalAiSettings = await prisma.aiSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
  originalLearningSettings = await getLearningSettings();

  preExistingActiveRuleIds = (
    await prisma.automationRule.findMany({ where: { status: "ACTIVE" }, select: { id: true } })
  ).map((r) => r.id);
  if (preExistingActiveRuleIds.length) {
    await prisma.automationRule.updateMany({ where: { id: { in: preExistingActiveRuleIds } }, data: { status: "DISABLED" } });
  }
});

afterAll(async () => {
  await prisma.automationSettings.update({ where: { id: "global" }, data: originalAutomationSettings as unknown as Prisma.AutomationSettingsUpdateInput });
  await prisma.aiSettings.update({ where: { id: "global" }, data: originalAiSettings as unknown as Prisma.AiSettingsUpdateInput });
  await prisma.learningSettings.update({ where: { id: "global" }, data: originalLearningSettings });
  if (preExistingActiveRuleIds.length) {
    await prisma.automationRule.updateMany({ where: { id: { in: preExistingActiveRuleIds } }, data: { status: "ACTIVE" } });
  }
});

beforeEach(async () => {
  await resetAutomationSettings();
  await prisma.aiSettings.update({
    where: { id: "global" },
    data: { aiEngineEnabled: true, autoResponseEnabled: true, autoResponseConfidenceThreshold: 90, humanReviewThreshold: 40 },
  });
  await prisma.learningSettings.update({
    where: { id: "global" },
    data: { conversationLearningEnabled: true, minOccurrenceForCandidate: 2, minDistinctGroupsForCandidate: 2, minDistinctClientsForCandidate: 2 },
  });
  account = await prisma.whatsAppAccount.create({ data: { label: `Cost Reduction Test ${randomUUID()}`, status: "CONNECTED" } });
});

afterEach(async () => {
  if (createdCandidateIds.length) {
    await prisma.patternCandidate.deleteMany({ where: { id: { in: createdCandidateIds } } }); // cascades RuleProposal
    createdCandidateIds.length = 0;
  }
  if (createdRuleIds.length) {
    await prisma.automationRule.deleteMany({ where: { id: { in: createdRuleIds } } });
    createdRuleIds.length = 0;
  }
  await prisma.learningBatchJob.deleteMany({ where: { jobType: "PATTERN_DETECTION" } });
  // Cascades WhatsAppGroup, Message (and AiFallbackDecision/AutomationExecution/OutboundMessage
  // from Message), and ConversationSession (and PatternCandidateEvidence from it) — see
  // schema.prisma's onDelete: Cascade on each of those relations back to WhatsAppAccount.
  await prisma.whatsAppAccount.delete({ where: { id: account.id } });
  createdGroupIds.length = 0;
});

describe("AI-handled pattern → Rule Proposal → activated rule → AI never called again", () => {
  it("closes the cost-reduction loop end to end", async () => {
    const groupA = await makeEligibleGroup();
    const groupB = await makeEligibleGroup();
    const customerBody = "internet connection speed problem";
    const aiReplyText = "We are checking your connection now and will update you shortly.";

    // Occurrences 1 & 2: two distinct clients in two distinct groups, both genuine rule misses,
    // both confidently answered by the (mocked) AI fallback layer.
    for (const group of [groupA, groupB]) {
      const client = new MockAiClient();
      client.nextText = `INTENT: internet issue\nCONFIDENCE: 96\nSHOULD_REPLY: YES\nRESPONSE: ${aiReplyText}`;
      const whatsappMessageId = randomUUID();

      await processIncomingMessage(
        {
          accountId: account.id,
          whatsappMessageId,
          whatsappGroupId: group.whatsappGroupId,
          chatId: group.whatsappGroupId,
          senderPhone: uniquePhone(),
          direction: "INCOMING",
          body: customerBody,
          timestampWa: new Date(),
        },
        client,
      );
      expect(client.requests).toHaveLength(1);

      const message = await prisma.message.findUniqueOrThrow({
        where: { accountId_whatsappMessageId: { accountId: account.id, whatsappMessageId } },
      });
      const decision = await prisma.aiFallbackDecision.findUniqueOrThrow({ where: { messageId: message.id } });
      expect(decision.outcome).toBe("AI_REPLIED");

      await closeMessageIntoOwnSession(message);
    }

    // Pattern detection turns that evidence into a floor-clearing, AI-sourced candidate.
    await processOnePatternDetectionBatch();
    const candidate = await prisma.patternCandidate.findFirstOrThrow({
      where: { suggestedKeywords: { hasSome: ["internet", "connection"] } },
    });
    createdCandidateIds.push(candidate.id);
    expect(candidate.occurrenceCount).toBe(2);
    expect(candidate.distinctGroupCount).toBe(2);
    expect(candidate.distinctClientCount).toBe(2);
    expect(candidate.status).toBe("PENDING_REVIEW");
    expect(candidate.suggestedReplyMessage).toBe(aiReplyText);

    const evidenceRows = await prisma.patternCandidateEvidence.findMany({ where: { patternCandidateId: candidate.id } });
    expect(evidenceRows).toHaveLength(2);
    expect(evidenceRows.every((e) => e.responseSource === "AI")).toBe(true);
    expect(evidenceRows.every((e) => e.wasResolved)).toBe(true);

    // Human review: create the proposal, approve it — reusing the exact same shared functions the
    // dashboard's manual "Create Proposal"/"Approve" buttons call.
    const proposalResult = await createRuleProposalFromCandidate(candidate.id);
    if (!("id" in proposalResult)) throw new Error(proposalResult.error);
    const approveResult = await approveRuleProposalById({ proposalId: proposalResult.id, reviewedById: null, autoApproved: false });
    if (!("ruleId" in approveResult)) throw new Error(approveResult.error);
    createdRuleIds.push(approveResult.ruleId);

    const draftRule = await prisma.automationRule.findUniqueOrThrow({ where: { id: approveResult.ruleId } });
    expect(draftRule.status).toBe("DRAFT");
    expect(draftRule.replyMessage).toBe(aiReplyText);

    // A DRAFT rule must never fire — matching message still reaches AI (proving the rule is truly
    // inert, not just "would have matched").
    const preActivationClient = new MockAiClient();
    preActivationClient.nextText = `INTENT: internet issue\nCONFIDENCE: 96\nSHOULD_REPLY: YES\nRESPONSE: ${aiReplyText}`;
    await processIncomingMessage(
      {
        accountId: account.id,
        whatsappMessageId: randomUUID(),
        whatsappGroupId: groupA.whatsappGroupId,
        chatId: groupA.whatsappGroupId,
        senderPhone: uniquePhone(),
        direction: "INCOMING",
        body: customerBody,
        timestampWa: new Date(),
      },
      preActivationClient,
    );
    expect(preActivationClient.requests).toHaveLength(1);

    // The human's separate "activate" step on the existing Rules page.
    await prisma.automationRule.update({ where: { id: approveResult.ruleId }, data: { status: "ACTIVE" } });

    // The exact same kind of message now hits the deterministic rule engine — AI is never invoked.
    const postActivationClient = new MockAiClient();
    await processIncomingMessage(
      {
        accountId: account.id,
        whatsappMessageId: randomUUID(),
        whatsappGroupId: groupA.whatsappGroupId,
        chatId: groupA.whatsappGroupId,
        senderPhone: uniquePhone(),
        direction: "INCOMING",
        body: customerBody,
        timestampWa: new Date(),
      },
      postActivationClient,
    );

    expect(postActivationClient.requests).toHaveLength(0); // the cost-reduction guarantee
    const finalExecution = await prisma.automationExecution.findFirstOrThrow({
      where: { ruleId: approveResult.ruleId },
      orderBy: { matchedAt: "desc" },
    });
    expect(finalExecution.decision).toBe("AUTO_REPLY");
    const finalOutbound = await prisma.outboundMessage.findFirstOrThrow({ where: { ruleId: approveResult.ruleId } });
    expect(finalOutbound.body).toBe(aiReplyText);
  });
});
