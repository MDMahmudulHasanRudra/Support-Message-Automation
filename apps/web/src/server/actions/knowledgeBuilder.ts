"use server";

import { revalidatePath } from "next/cache";
import { createKnowledgeItem, prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";

/**
 * Knowledge Builder — "Learn from Conversations".
 *
 * The web half queues a run and reviews what comes back; the worker
 * (apps/worker/src/knowledge/conversationAnalysisJob.ts) does the reading and the extraction.
 * The split is the usual one in this app: anything needing an AI call or a long scan belongs to
 * the worker, and the two coordinate through Postgres rather than HTTP.
 */

const MAX_GROUPS_PER_RUN = 25;
const DEFAULT_MESSAGE_LIMIT = 200;
const MAX_MESSAGE_LIMIT = 400;

export type AnalysisRangeKind = "LATEST_MESSAGES" | "LAST_24_HOURS" | "LAST_7_DAYS" | "CUSTOM";

const RANGE_KINDS: readonly AnalysisRangeKind[] = [
  "LATEST_MESSAGES",
  "LAST_24_HOURS",
  "LAST_7_DAYS",
  "CUSTOM",
];

export interface StartAnalysisResult {
  ok: boolean;
  runId?: string;
  error?: string;
}

/**
 * Queues an analysis over the selected groups. Returns immediately — the worker works through the
 * groups one per tick and the page polls for progress, so a run over twenty groups does not sit in
 * a request for several minutes.
 */
export async function startConversationAnalysis(input: {
  groupIds: string[];
  rangeKind: string;
  rangeStart?: string;
  rangeEnd?: string;
  messageLimit?: number;
  label?: string;
}): Promise<StartAnalysisResult> {
  const session = await requireSession();

  const groupIds = [...new Set(input.groupIds.filter((id) => typeof id === "string" && id.length > 0))];
  if (groupIds.length === 0) return { ok: false, error: "Select at least one group to analyse." };
  if (groupIds.length > MAX_GROUPS_PER_RUN) {
    return {
      ok: false,
      error: `Select up to ${MAX_GROUPS_PER_RUN} groups at a time — each one is a separate AI call.`,
    };
  }

  if (!isRangeKind(input.rangeKind)) return { ok: false, error: "Pick a time range." };

  // Only groups that actually exist go into the snapshot, so the worker's cursor can never point
  // at a stale id from a form somebody left open.
  const existing = await prisma.whatsAppGroup.findMany({
    where: { id: { in: groupIds } },
    select: { id: true },
  });
  if (existing.length === 0) return { ok: false, error: "None of those groups exist any more." };

  let rangeStart: Date | null = null;
  let rangeEnd: Date | null = null;
  if (input.rangeKind === "CUSTOM") {
    rangeStart = parseDate(input.rangeStart);
    rangeEnd = parseDate(input.rangeEnd);
    if (!rangeStart) return { ok: false, error: "Give the custom range a start date." };
    if (rangeEnd && rangeEnd < rangeStart) return { ok: false, error: "The end date is before the start date." };
  }

  // Clamped server-side rather than trusted from the form — the same convention the broadcast
  // throttles and the retry schedule use.
  const messageLimit =
    input.rangeKind === "LATEST_MESSAGES"
      ? Math.max(10, Math.min(MAX_MESSAGE_LIMIT, Math.floor(input.messageLimit ?? DEFAULT_MESSAGE_LIMIT)))
      : null;

  const run = await prisma.conversationAnalysisRun.create({
    data: {
      label: input.label?.trim() || null,
      groupIds: existing.map((g) => g.id),
      rangeKind: input.rangeKind,
      rangeStart,
      rangeEnd,
      messageLimit,
      groupsTotal: existing.length,
      createdById: session.userId,
    },
    select: { id: true },
  });

  revalidatePath("/conversation-learning/knowledge-builder");
  return { ok: true, runId: run.id };
}

export interface CandidateActionResult {
  ok: boolean;
  error?: string;
}

/**
 * Approving a candidate publishes it: it creates the AiKnowledgeItem, verified, so the assistant
 * can use it immediately.
 *
 * That is deliberately different from the AI Sandbox, where approval only means "the AI handled
 * this well" and a second verification step follows. Here the reviewer is reading the extracted
 * question and answer themselves, with the option to edit both first — that IS the verification,
 * and the flow this feature was specified with ends at "Approved → Validated Knowledge". Making
 * them approve it twice, in two different queues, would only teach people to click through both.
 */
export async function approveConversationCandidate(candidateId: string): Promise<CandidateActionResult> {
  const session = await requireSession();

  const candidate = await prisma.conversationCandidate.findUnique({ where: { id: candidateId } });
  if (!candidate) return { ok: false, error: "That candidate no longer exists." };
  if (candidate.promotedKnowledgeItemId) {
    return { ok: false, error: "This candidate is already in the knowledge base." };
  }

  // Through the shared writer, which is what gives this entry a version row, a content hash and a
  // scope. It wrote none of the three before: an entry promoted from a conversation claimed
  // `currentVersion: 1` with no version behind it, so an evidence snapshot pointing at version 1
  // would resolve to nothing.
  const item = await createKnowledgeItem({
    title: candidate.title,
    category: candidate.category,
    question: candidate.question,
    answer: candidate.answer,
    procedure: candidate.procedure,
    module: candidate.module,
    source: "CONVERSATION_BUILDER",
    // Distilled from ONE group's conversation, so `createKnowledgeItem` derives GROUP scope from
    // it — and that is the important part. Approving this used to make one group's information
    // retrievable in every other group, which is the isolation boundary this whole change exists
    // to draw. A person who judges it true of the product rather than of that customer promotes it
    // to GLOBAL deliberately.
    sourceGroupId: candidate.groupId,
    sourceLabel: `Conversation in ${candidate.groupName}`,
    confidence: candidate.confidence,
    // Machine-extracted, so this stays true — but a person has read it and approved it here,
    // which is exactly what humanVerified records.
    aiGenerated: true,
    humanVerified: true,
    createdById: session.userId,
    verifiedById: session.userId,
    changeSummary: "Approved from a conversation candidate.",
  });

  await prisma.conversationCandidate.update({
    where: { id: candidateId },
    data: {
      status: "APPROVED",
      reviewedById: session.userId,
      reviewedAt: new Date(),
      promotedKnowledgeItemId: item.id,
    },
  });

  revalidatePath("/conversation-learning/knowledge-builder");
  revalidatePath("/ai-learning/knowledge-base");
  return { ok: true };
}

/** Rejected candidates are kept, never deleted — "what did we turn down, and why" is the record
 *  that stops the same proposal being re-argued on every run. */
export async function rejectConversationCandidate(candidateId: string): Promise<CandidateActionResult> {
  const session = await requireSession();

  const candidate = await prisma.conversationCandidate.findUnique({
    where: { id: candidateId },
    select: { id: true, promotedKnowledgeItemId: true },
  });
  if (!candidate) return { ok: false, error: "That candidate no longer exists." };
  if (candidate.promotedKnowledgeItemId) {
    return {
      ok: false,
      error: "This one is already in the knowledge base — archive it there instead.",
    };
  }

  await prisma.conversationCandidate.update({
    where: { id: candidateId },
    data: { status: "REJECTED", reviewedById: session.userId, reviewedAt: new Date() },
  });

  revalidatePath("/conversation-learning/knowledge-builder");
  return { ok: true };
}

/**
 * Corrects a candidate before it is approved. Editing after approval is deliberately refused: at
 * that point the real record is the knowledge entry, and letting the two drift apart would make
 * the candidate a misleading account of what was actually published.
 */
export async function updateConversationCandidate(
  candidateId: string,
  input: { title: string; question?: string; answer: string },
): Promise<CandidateActionResult> {
  await requireSession();

  const title = input.title?.trim();
  const answer = input.answer?.trim();
  if (!title) return { ok: false, error: "A candidate needs a title." };
  if (!answer) return { ok: false, error: "A candidate needs an answer." };

  const candidate = await prisma.conversationCandidate.findUnique({
    where: { id: candidateId },
    select: { id: true, promotedKnowledgeItemId: true },
  });
  if (!candidate) return { ok: false, error: "That candidate no longer exists." };
  if (candidate.promotedKnowledgeItemId) {
    return { ok: false, error: "Edit it in the knowledge base — this one has already been published." };
  }

  await prisma.conversationCandidate.update({
    where: { id: candidateId },
    data: { title, question: input.question?.trim() || null, answer },
  });

  revalidatePath("/conversation-learning/knowledge-builder");
  return { ok: true };
}

/** Deletes a run and its candidates. Knowledge entries already approved out of it are untouched —
 *  they are their own records now, which is why promotedKnowledgeItemId is not a relation. */
export async function deleteConversationAnalysisRun(runId: string): Promise<CandidateActionResult> {
  await requireSession();
  await prisma.conversationAnalysisRun.deleteMany({ where: { id: runId } });
  revalidatePath("/conversation-learning/knowledge-builder");
  return { ok: true };
}

function isRangeKind(value: string): value is AnalysisRangeKind {
  return (RANGE_KINDS as readonly string[]).includes(value);
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
