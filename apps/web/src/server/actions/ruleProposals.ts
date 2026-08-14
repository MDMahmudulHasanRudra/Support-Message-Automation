"use server";

import { revalidatePath } from "next/cache";
import { prisma, createRuleProposalFromCandidate, approveRuleProposalById } from "@support-automation/db";
import { requireSession } from "@/server/auth";

/**
 * Conversation Learning Phase 3/4/6 — human review + real rule execution + auto-approval. The
 * actual candidate->proposal and proposal->rule conversion logic lives in
 * packages/db/src/index.ts's createRuleProposalFromCandidate()/approveRuleProposalById() — shared
 * with apps/worker's auto-approval path (patternDetectionJob.ts's rescoreCandidate()) so both stay
 * identical. This file is the thin, session-gated web wrapper: auth + cache revalidation only.
 */

export async function createRuleProposal(candidateId: string): Promise<{ id: string } | { error: string }> {
  await requireSession();
  const result = await createRuleProposalFromCandidate(candidateId);

  if ("id" in result) {
    revalidatePath("/conversation-learning/pattern-candidates");
    revalidatePath(`/conversation-learning/pattern-candidates/${candidateId}`);
    revalidatePath("/conversation-learning/rule-proposals");
  }
  return result;
}

export async function approveRuleProposal(id: string): Promise<{ error?: string }> {
  const session = await requireSession();
  const result = await approveRuleProposalById({ proposalId: id, reviewedById: session.userId, autoApproved: false });

  if ("error" in result) return { error: result.error };

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
