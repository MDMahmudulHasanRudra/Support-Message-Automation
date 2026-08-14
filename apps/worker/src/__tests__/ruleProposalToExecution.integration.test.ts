import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@support-automation/db";
import type { AutomationSettings, Prisma, WhatsAppAccount, WhatsAppGroup } from "@prisma/client";
import { processIncomingMessage } from "../pipeline/processIncomingMessage.js";
import { processOne } from "../queue/outboundQueueProcessor.js";
import { MockProvider } from "./mockProvider.js";

/**
 * End-to-end proof that a Rule Proposal's data shape — exactly what
 * apps/web/src/server/actions/ruleProposals.ts's createRuleProposal()/approveRuleProposal() write
 * — actually executes through the completely unmodified rule engine, pipeline, and outbound queue
 * once a human activates it. apps/web has no test infrastructure of its own (no vitest config, no
 * existing tests for any server action, confirmed across this whole repo) — server actions there
 * depend on next/headers' request-scoped cookies(), which only exists inside a real Next.js
 * request, so they can't be unit-tested from here either. This suite instead verifies the DATA
 * SHAPE end of that contract from the worker side, which is where the real execution risk lives:
 * steps 2-3 below mirror those two functions' exact Prisma writes by hand.
 */

let originalSettings: AutomationSettings;
let account: WhatsAppAccount;
let group: WhatsAppGroup;
const createdRuleIds: string[] = [];
const createdCandidateIds: string[] = [];
let preExistingActiveRuleIds: string[] = [];

function uniquePhone(): string {
  return `+8809${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

function uniqueGroupJid(): string {
  return `${randomUUID().replace(/-/g, "").slice(0, 10)}-1234567890@g.us`;
}

async function resetSettings(overrides: Partial<Prisma.AutomationSettingsUpdateInput> = {}) {
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

beforeAll(async () => {
  originalSettings = await prisma.automationSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
  preExistingActiveRuleIds = (
    await prisma.automationRule.findMany({ where: { status: "ACTIVE" }, select: { id: true } })
  ).map((r) => r.id);
  if (preExistingActiveRuleIds.length) {
    await prisma.automationRule.updateMany({ where: { id: { in: preExistingActiveRuleIds } }, data: { status: "DISABLED" } });
  }
});

afterAll(async () => {
  await prisma.automationSettings.update({
    where: { id: "global" },
    data: originalSettings as unknown as Prisma.AutomationSettingsUpdateInput,
  });
  if (preExistingActiveRuleIds.length) {
    await prisma.automationRule.updateMany({ where: { id: { in: preExistingActiveRuleIds } }, data: { status: "ACTIVE" } });
  }
});

beforeEach(async () => {
  await resetSettings();
  account = await prisma.whatsAppAccount.create({
    data: { label: `Proposal Flow Test ${randomUUID()}`, status: "CONNECTED" },
  });
  group = await prisma.whatsAppGroup.create({
    data: {
      accountId: account.id,
      whatsappGroupId: uniqueGroupJid(),
      name: "Test Support Group",
      isMonitored: true,
      lastSyncedAt: new Date(),
    },
  });
});

afterEach(async () => {
  await prisma.outboundMessage.deleteMany({ where: { accountId: account.id } });
  await prisma.automationExecution.deleteMany({ where: { message: { accountId: account.id } } });
  await prisma.message.deleteMany({ where: { accountId: account.id } });
  await prisma.whatsAppAccount.delete({ where: { id: account.id } }); // cascades WhatsAppGroup
  if (createdRuleIds.length) {
    await prisma.automationRule.deleteMany({ where: { id: { in: createdRuleIds } } });
    createdRuleIds.length = 0;
  }
  if (createdCandidateIds.length) {
    await prisma.patternCandidate.deleteMany({ where: { id: { in: createdCandidateIds } } }); // cascades RuleProposal
    createdCandidateIds.length = 0;
  }
});

describe("Rule Proposal -> real AutomationRule -> execution", () => {
  it("a rule created with the exact shape approveRuleProposal() writes stays inert as DRAFT, then matches and auto-replies once a human activates it", async () => {
    // 1. Simulate deterministic pattern-detection's output.
    const candidate = await prisma.patternCandidate.create({
      data: {
        patternKey: `test-${randomUUID()}`,
        suggestedMatchType: "KEYWORDS",
        suggestedKeywords: ["internet", "slow"],
        suggestedReplyMessage: "Please restart your router and try again.",
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        occurrenceCount: 5,
        distinctGroupCount: 3,
        distinctClientCount: 3,
        confidenceScore: 82,
      },
    });
    createdCandidateIds.push(candidate.id);

    // 2. Mirrors createRuleProposal()'s exact field mapping.
    const proposal = await prisma.ruleProposal.create({
      data: {
        patternCandidateId: candidate.id,
        name: `Pattern: ${candidate.suggestedKeywords.join(", ")}`,
        type: "AUTO_REPLY",
        matchType: candidate.suggestedMatchType,
        keywords: candidate.suggestedKeywords,
        actions: [{ type: "AUTO_REPLY" }],
        replyMessage: candidate.suggestedReplyMessage,
        confidenceScoreSnapshot: candidate.confidenceScore,
      },
    });

    // 3. Mirrors approveRuleProposal()'s transaction: the created rule is always DRAFT.
    const createdRule = await prisma.automationRule.create({
      data: {
        name: proposal.name,
        type: proposal.type,
        matchType: proposal.matchType,
        keywords: proposal.keywords,
        conditions: proposal.conditions as object,
        actions: proposal.actions as object,
        priority: proposal.priority,
        status: "DRAFT",
        replyMessage: proposal.replyMessage,
      },
    });
    createdRuleIds.push(createdRule.id);
    await prisma.ruleProposal.update({
      where: { id: proposal.id },
      data: { status: "APPROVED", createdRuleId: createdRule.id },
    });
    await prisma.patternCandidate.update({ where: { id: candidate.id }, data: { status: "APPROVED" } });

    // 4. A DRAFT rule must never fire — proves the safety gate before the human's separate
    // activation step, which is the whole point of always creating it as DRAFT.
    await processIncomingMessage({
      accountId: account.id,
      whatsappMessageId: randomUUID(),
      chatId: group.whatsappGroupId,
      whatsappGroupId: group.whatsappGroupId,
      senderPhone: uniquePhone(),
      senderName: "Client",
      direction: "INCOMING",
      body: "internet is very slow today",
      timestampWa: new Date(),
    });
    let executions = await prisma.automationExecution.findMany({ where: { ruleId: createdRule.id } });
    expect(executions).toHaveLength(0);

    // 5. The human's separate "activate" step on the existing Rules page.
    await prisma.automationRule.update({ where: { id: createdRule.id }, data: { status: "ACTIVE" } });

    // 6. The exact same kind of message now fires through the completely unmodified engine/pipeline.
    await processIncomingMessage({
      accountId: account.id,
      whatsappMessageId: randomUUID(),
      chatId: group.whatsappGroupId,
      whatsappGroupId: group.whatsappGroupId,
      senderPhone: uniquePhone(),
      senderName: "Client",
      direction: "INCOMING",
      body: "internet is very slow today",
      timestampWa: new Date(),
    });

    executions = await prisma.automationExecution.findMany({ where: { ruleId: createdRule.id } });
    expect(executions).toHaveLength(1);
    expect(executions[0]!.decision).toBe("AUTO_REPLY");

    const outbound = await prisma.outboundMessage.findFirstOrThrow({
      where: { accountId: account.id, ruleId: createdRule.id },
    });
    expect(outbound.body).toBe("Please restart your router and try again.");
    expect(outbound.status).toBe("PENDING");

    // 7. The unmodified outbound queue actually sends it.
    const provider = new MockProvider();
    const sent = await processOne(provider);
    expect(sent).toBe(true);
    expect(provider.sentMessages).toHaveLength(1);
  });
});
