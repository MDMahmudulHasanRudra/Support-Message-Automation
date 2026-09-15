"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";

/**
 * The AI Sandbox's web side. Every action here writes to SandboxSession/SandboxTurn and
 * nothing else — the one deliberate exception is `promoteSandboxAnswer`, which is the single,
 * explicit door from the sandbox into the knowledge base, and even that lands UNVERIFIED in
 * the existing review queue rather than as live knowledge. See sandboxJob.ts for the worker
 * half and for the full list of production side effects the sandbox does not perform.
 */

const MAX_MESSAGE_LENGTH = 2000;

export interface SandboxActionResult {
  ok: boolean;
  error?: string;
}

export async function createSandboxSession(input: {
  label?: string;
  groupId?: string | null;
}): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
  const session = await requireSession();

  const label = input.label?.trim() || null;
  const groupId = input.groupId?.trim() || null;

  // A group is optional context, never a target. Validated only so a stale id cannot
  // become a dangling reference — nothing is ever written to the group itself.
  if (groupId) {
    const group = await prisma.whatsAppGroup.findUnique({ where: { id: groupId }, select: { id: true } });
    if (!group) return { ok: false, error: "That group no longer exists." };
  }

  const created = await prisma.sandboxSession.create({
    data: { label, groupId, createdById: session.userId },
    select: { id: true },
  });

  revalidatePath("/conversation-learning/sandbox");
  return { ok: true, sessionId: created.id };
}

/**
 * Queues one test message. Returns as soon as the row is written — the worker picks it up
 * within a couple of seconds and the page polls for the answer, the same DB-mediated
 * hand-off every other web→worker action in this app uses.
 */
export async function sendSandboxMessage(
  sessionId: string,
  message: string,
): Promise<{ ok: boolean; turnId?: string; error?: string }> {
  await requireSession();

  const body = message.trim();
  if (!body) return { ok: false, error: "Type a message first." };
  if (body.length > MAX_MESSAGE_LENGTH) {
    return { ok: false, error: `Keep the test message under ${MAX_MESSAGE_LENGTH} characters.` };
  }

  const sandboxSession = await prisma.sandboxSession.findUnique({
    where: { id: sessionId },
    select: { id: true },
  });
  if (!sandboxSession) return { ok: false, error: "That sandbox conversation no longer exists." };

  // One unanswered turn at a time: a conversation is a sequence, and queueing a follow-up
  // before the previous answer exists would build the next prompt from an incomplete
  // transcript.
  const inFlight = await prisma.sandboxTurn.count({
    where: { sessionId, status: { in: ["PENDING", "PROCESSING"] } },
  });
  if (inFlight > 0) return { ok: false, error: "Still waiting for the previous answer." };

  const turn = await prisma.sandboxTurn.create({
    data: { sessionId, userMessage: body },
    select: { id: true },
  });

  revalidatePath("/conversation-learning/sandbox");
  return { ok: true, turnId: turn.id };
}

/**
 * The admin's verdict. APPROVED marks a turn a validated learning example and nothing more —
 * it does not create knowledge, does not touch any rule, and changes no production behaviour.
 * Promotion is a separate, explicit action below, which is what keeps "Sandbox never reaches
 * production in one step" true in code rather than only in the documentation.
 */
export async function setSandboxReview(
  turnId: string,
  review: "WAITING" | "APPROVED" | "REJECTED",
  note?: string,
): Promise<SandboxActionResult> {
  const session = await requireSession();

  const turn = await prisma.sandboxTurn.findUnique({
    where: { id: turnId },
    select: { id: true, status: true },
  });
  if (!turn) return { ok: false, error: "That answer no longer exists." };
  if (turn.status !== "COMPLETE") return { ok: false, error: "This turn has no answer to review yet." };

  await prisma.sandboxTurn.update({
    where: { id: turnId },
    data: {
      review,
      reviewNote: note?.trim() || null,
      // Clearing the reviewer on a reset to WAITING keeps "who decided this" honest — a turn
      // nobody has judged must not carry a name.
      reviewedById: review === "WAITING" ? null : session.userId,
      reviewedAt: review === "WAITING" ? null : new Date(),
    },
  });

  revalidatePath("/conversation-learning/sandbox");
  return { ok: true };
}

/**
 * The one door from the sandbox into the knowledge base, and it is deliberately narrow.
 *
 * Only an APPROVED turn that actually produced an answer can go through, it can only go
 * through once, and what it creates is `humanVerified: false` — so it lands in the SAME
 * pending-review queue every machine-written entry goes through
 * (/ai-learning/knowledge-base/review) rather than becoming something the AI can quote at a
 * customer straight away.
 *
 * That second review is not redundant bureaucracy: approving an answer in a sandbox means
 * "the AI handled this well", while verifying a knowledge entry means "this is true and the
 * assistant may state it to a customer". They are different judgements, and a testing tool
 * must not be able to make the second one.
 */
export async function promoteSandboxAnswer(
  turnId: string,
  input: { title: string; category?: string },
): Promise<{ ok: boolean; knowledgeItemId?: string; error?: string }> {
  const session = await requireSession();

  const title = input.title?.trim();
  if (!title) return { ok: false, error: "Give the knowledge entry a title." };

  const turn = await prisma.sandboxTurn.findUnique({
    where: { id: turnId },
    select: {
      id: true,
      userMessage: true,
      responseText: true,
      review: true,
      confidenceScore: true,
      promotedKnowledgeItemId: true,
      session: { select: { groupId: true } },
    },
  });
  if (!turn) return { ok: false, error: "That answer no longer exists." };
  if (turn.review !== "APPROVED") return { ok: false, error: "Approve the answer before saving it as knowledge." };
  if (!turn.responseText) return { ok: false, error: "This turn produced no answer to save." };
  if (turn.promotedKnowledgeItemId) {
    return { ok: false, error: "This answer has already been saved to the knowledge base." };
  }

  const category = isKnowledgeCategory(input.category) ? input.category : "FAQ";

  const item = await prisma.aiKnowledgeItem.create({
    data: {
      title,
      category,
      question: turn.userMessage,
      answer: turn.responseText,
      // Sandbox-authored, machine-drafted, and explicitly NOT verified — the whole point of
      // the gate described in this function's doc comment.
      source: "SANDBOX",
      sourceLabel: "Approved in AI Sandbox",
      sourceGroupId: turn.session.groupId,
      confidence: turn.confidenceScore,
      aiGenerated: true,
      humanVerified: false,
      createdById: session.userId,
    },
    select: { id: true },
  });

  await prisma.sandboxTurn.update({
    where: { id: turnId },
    data: { promotedKnowledgeItemId: item.id },
  });

  revalidatePath("/conversation-learning/sandbox");
  revalidatePath("/ai-learning/knowledge-base/review");
  return { ok: true, knowledgeItemId: item.id };
}

export async function deleteSandboxSession(sessionId: string): Promise<SandboxActionResult> {
  await requireSession();
  // Turns cascade with the session (schema-level), and nothing outside these two tables
  // references either, so this genuinely deletes only test data.
  await prisma.sandboxSession.deleteMany({ where: { id: sessionId } });
  revalidatePath("/conversation-learning/sandbox");
  return { ok: true };
}

/** The AiKnowledgeCategory values a promoted sandbox answer may land in. */
const PROMOTABLE_CATEGORIES = [
  "FAQ",
  "CUSTOMER_RESPONSE",
  "TROUBLESHOOTING",
  "WORKFLOW",
  "SOFTWARE",
  "POLICY",
] as const;

type PromotableCategory = (typeof PROMOTABLE_CATEGORIES)[number];

function isKnowledgeCategory(value: string | undefined): value is PromotableCategory {
  return typeof value === "string" && (PROMOTABLE_CATEGORIES as readonly string[]).includes(value);
}
