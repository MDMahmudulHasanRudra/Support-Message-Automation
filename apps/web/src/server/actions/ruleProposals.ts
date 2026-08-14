"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@support-automation/db";
import { validateRegexSafety } from "@support-automation/engine";
import type { RuleAction } from "@support-automation/shared";
import { requireSession } from "@/server/auth";

/**
 * Conversation Learning Phase 3/4 — human review + real rule execution. Creating a proposal is a
 * one-time, human-initiated action (RuleProposal.patternCandidateId is unique — a rejected/
 * withdrawn proposal is never replaced; fresh evidence keeps accumulating on the same candidate
 * instead). Approving one is a pure copy into a real AutomationRule row, reusing the exact same
 * regex-safety gate apps/web/src/server/actions/rules.ts uses — no parallel validation, no
 * parallel rule engine. The created rule always lands as DRAFT, never ACTIVE: a human still has
 * to make the separate, already-audited "go live" decision on the existing Rules page.
 */

/** One AUTO_REPLY action if the pattern has an observed reply to suggest, otherwise a safe SUPPORT_REQUIRED fallback. */
function deriveSuggestedActions(suggestedReplyMessage: string | null): RuleAction[] {
  return suggestedReplyMessage ? [{ type: "AUTO_REPLY" }] : [{ type: "SUPPORT_REQUIRED" }];
}

function deriveProposalName(keywords: string[]): string {
  const label = keywords.join(", ") || "unlabeled pattern";
  return `Pattern: ${label}`.slice(0, 120);
}

export async function createRuleProposal(candidateId: string): Promise<{ id: string } | { error: string }> {
  await requireSession();

  const candidate = await prisma.patternCandidate.findUnique({
    where: { id: candidateId },
    include: { proposal: true },
  });
  if (!candidate) return { error: "Pattern candidate not found." };
  if (candidate.proposal) return { error: "A proposal already exists for this pattern." };

  const proposal = await prisma.ruleProposal.create({
    data: {
      patternCandidateId: candidate.id,
      name: deriveProposalName(candidate.suggestedKeywords),
      description: `Auto-drafted from a recurring conversation pattern (${candidate.occurrenceCount} occurrences across ${candidate.distinctGroupCount} group(s), ${candidate.distinctClientCount} client(s)).`,
      type: candidate.suggestedReplyMessage ? "AUTO_REPLY" : "GENERIC",
      matchType: candidate.suggestedMatchType,
      matchValue: candidate.suggestedMatchValue,
      keywords: candidate.suggestedKeywords,
      actions: deriveSuggestedActions(candidate.suggestedReplyMessage) as unknown as object,
      replyMessage: candidate.suggestedReplyMessage,
      confidenceScoreSnapshot: candidate.confidenceScore,
    },
  });

  revalidatePath("/conversation-learning/pattern-candidates");
  revalidatePath(`/conversation-learning/pattern-candidates/${candidateId}`);
  revalidatePath("/conversation-learning/rule-proposals");
  return { id: proposal.id };
}

export async function approveRuleProposal(id: string): Promise<{ error?: string }> {
  const session = await requireSession();
  const proposal = await prisma.ruleProposal.findUniqueOrThrow({ where: { id } });

  if (proposal.status !== "PENDING_REVIEW") {
    return { error: "This proposal has already been reviewed." };
  }

  // Same gate rules.ts applies at rule-save time — reused, never duplicated. Pattern-derived
  // proposals are always matchType KEYWORDS today, so this is defense-in-depth for a future
  // manually-edited proposal, not a path exercised by the current generator.
  if (proposal.matchType === "REGEX" && proposal.matchValue) {
    const check = validateRegexSafety(proposal.matchValue);
    if (!check.safe) return { error: `Regex rejected: ${check.reason}` };
  }

  await prisma.$transaction(async (tx) => {
    const createdRule = await tx.automationRule.create({
      data: {
        name: proposal.name,
        description: proposal.description,
        type: proposal.type,
        matchType: proposal.matchType,
        matchValue: proposal.matchValue,
        keywords: proposal.keywords,
        conditions: proposal.conditions as object,
        actions: proposal.actions as object,
        priority: proposal.priority,
        // Always DRAFT, even here — a human must still make the separate "activate" decision on
        // the Rules page before this can execute against real messages.
        status: "DRAFT",
        cooldownSeconds: proposal.cooldownSeconds,
        replyMessage: proposal.replyMessage,
        replyDelayMinMs: proposal.replyDelayMinMs,
        replyDelayMaxMs: proposal.replyDelayMaxMs,
        createdById: session.userId,
      },
    });
    await tx.ruleProposal.update({
      where: { id },
      data: { status: "APPROVED", createdRuleId: createdRule.id, reviewedById: session.userId, reviewedAt: new Date() },
    });
    await tx.patternCandidate.update({
      where: { id: proposal.patternCandidateId },
      data: { status: "APPROVED" },
    });
  });

  revalidatePath("/rules");
  revalidatePath("/conversation-learning/rule-proposals");
  revalidatePath(`/conversation-learning/rule-proposals/${id}`);
  revalidatePath("/conversation-learning/pattern-candidates");
  return {};
}

export async function rejectRuleProposal(id: string, reviewNote: string | null): Promise<void> {
  const session = await requireSession();
  const proposal = await prisma.ruleProposal.findUniqueOrThrow({ where: { id } });
  if (proposal.status !== "PENDING_REVIEW") return;

  await prisma.$transaction([
    prisma.ruleProposal.update({
      where: { id },
      data: { status: "REJECTED", reviewedById: session.userId, reviewedAt: new Date(), reviewNote },
    }),
    prisma.patternCandidate.update({ where: { id: proposal.patternCandidateId }, data: { status: "REJECTED" } }),
  ]);

  revalidatePath("/conversation-learning/rule-proposals");
  revalidatePath(`/conversation-learning/rule-proposals/${id}`);
  revalidatePath("/conversation-learning/pattern-candidates");
}

export async function withdrawRuleProposal(id: string): Promise<void> {
  const session = await requireSession();
  const proposal = await prisma.ruleProposal.findUniqueOrThrow({ where: { id } });
  if (proposal.status !== "PENDING_REVIEW") return;

  await prisma.ruleProposal.update({
    where: { id },
    data: { status: "WITHDRAWN", reviewedById: session.userId, reviewedAt: new Date() },
  });

  revalidatePath("/conversation-learning/rule-proposals");
  revalidatePath(`/conversation-learning/rule-proposals/${id}`);
}
