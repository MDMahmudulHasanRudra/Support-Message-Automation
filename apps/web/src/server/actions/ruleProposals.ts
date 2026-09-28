"use server";

import { projectPath } from "@/server/projectPaths";
import { prisma } from "@/server/db";
import { revalidatePath } from "next/cache";
import { createRuleProposalFromCandidate, approveRuleProposalById } from "@support-automation/db";
import { checkPermission, requireAccess } from "@/server/authorize";

/**
 * Conversation Learning Phase 3/4/6 — human review + real rule execution + auto-approval. The
 * actual candidate->proposal and proposal->rule conversion logic lives in
 * packages/db/src/index.ts's createRuleProposalFromCandidate()/approveRuleProposalById() — shared
 * with apps/worker's auto-approval path (patternDetectionJob.ts's rescoreCandidate()) so both stay
 * identical. This file is the thin, session-gated web wrapper: auth + cache revalidation only.
 */

export async function createRuleProposal(candidateId: string): Promise<{ id: string } | { error: string }> {
  const granted = await checkPermission("conversation_learning.manage");
  if ("denied" in granted) return { error: granted.denied };
  const result = await createRuleProposalFromCandidate(candidateId, prisma);

  if ("id" in result) {
    revalidatePath(await projectPath("/conversation-learning/pattern-candidates"));
    revalidatePath(await projectPath(`/conversation-learning/pattern-candidates/${candidateId}`));
    revalidatePath(await projectPath("/conversation-learning/rule-proposals"));
  }
  return result;
}

export async function approveRuleProposal(id: string): Promise<{ error?: string }> {
  const granted = await checkPermission("conversation_learning.manage");
  if ("denied" in granted) return { error: granted.denied };
  const session = granted.session;
  const result = await approveRuleProposalById({ proposalId: id, reviewedById: session.userId, autoApproved: false }, prisma);

  if ("error" in result) return { error: result.error };

  revalidatePath(await projectPath("/rules"));
  revalidatePath(await projectPath("/conversation-learning/rule-proposals"));
  revalidatePath(await projectPath(`/conversation-learning/rule-proposals/${id}`));
  revalidatePath(await projectPath("/conversation-learning/pattern-candidates"));
  return {};
}

export async function rejectRuleProposal(id: string, reviewNote: string | null): Promise<void> {
  const session = await requireAccess("conversation_learning.manage");
  const proposal = await prisma.ruleProposal.findUniqueOrThrow({ where: { id } });
  if (proposal.status !== "PENDING_REVIEW") return;

  await prisma.$transaction([
    prisma.ruleProposal.update({
      where: { id },
      data: { status: "REJECTED", reviewedById: session.userId, reviewedAt: new Date(), reviewNote },
    }),
    // Only a CONVERSATION_LEARNING proposal has a pattern candidate behind it. An AI_REPLY
    // proposal is drafted from one answered message, so there is nothing upstream to reject.
    ...(proposal.patternCandidateId
      ? [prisma.patternCandidate.update({ where: { id: proposal.patternCandidateId }, data: { status: "REJECTED" } })]
      : []),
  ]);

  revalidatePath(await projectPath("/conversation-learning/rule-proposals"));
  revalidatePath(await projectPath(`/conversation-learning/rule-proposals/${id}`));
  revalidatePath(await projectPath("/conversation-learning/pattern-candidates"));
}

export async function withdrawRuleProposal(id: string): Promise<void> {
  const session = await requireAccess("conversation_learning.manage");
  const proposal = await prisma.ruleProposal.findUniqueOrThrow({ where: { id } });
  if (proposal.status !== "PENDING_REVIEW") return;

  await prisma.ruleProposal.update({
    where: { id },
    data: { status: "WITHDRAWN", reviewedById: session.userId, reviewedAt: new Date() },
  });

  revalidatePath(await projectPath("/conversation-learning/rule-proposals"));
  revalidatePath(await projectPath(`/conversation-learning/rule-proposals/${id}`));
}
