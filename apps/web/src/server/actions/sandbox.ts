"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@support-automation/db";
import { DUPLICATE_QUESTION_THRESHOLD, deriveQueryTerms, questionSimilarity } from "@support-automation/engine";
import {
  applySandboxEdit,
  canEditSandboxAnswer,
  canMakeSandboxKnowledge,
  canSetSandboxReview,
  knowledgeContentHash,
  sandboxFinalAnswer,
} from "@support-automation/shared";
import { checkPermission } from "@/server/authorize";
import { logSystemEvent } from "@/server/logSystemEvent";
import { getGrantedPermissionKeys } from "@/server/permissions";

/**
 * The AI Sandbox's web side. Every action here writes to SandboxSession/SandboxTurn and
 * nothing else — the one deliberate exception is `makeKnowledgeFromSandbox`, the single,
 * explicit door from the sandbox into the knowledge base. Nothing here writes a Message, an
 * OutboundMessage or a Notification, so no sandbox action can reach a customer or a group. See
 * sandboxJob.ts for the worker half.
 *
 * THE WORKFLOW, and the rules enforced here rather than only hidden in the UI:
 *   ask -> AI answers -> (edit) -> Verify -> Make Knowledge
 *   1. The FINAL answer is `editedResponseText ?? responseText`. Verify and Make Knowledge use
 *      only that; the original AI answer is kept, never overwritten, as the audit trail.
 *   2. Only a VERIFIED (APPROVED) answer can become knowledge.
 *   3. A REJECTED answer cannot be edited or saved — it has to be reopened first.
 *   4. Saving an edit to a verified answer returns it to Waiting: the verification was of the
 *      old words, and must be given again for the new ones.
 *   5. Before creating, similar existing knowledge is looked for and shown; nothing existing is
 *      ever modified, and creating anyway is the admin's explicit choice.
 */

const MAX_MESSAGE_LENGTH = 2000;
/** The knowledge base's own answer limit (MAX_KNOWLEDGE_ANSWER_LENGTH), so a saved edit always fits. */
const MAX_ANSWER_LENGTH = 8000;

/** The one definition of "the answer" for a turn — packages/shared/src/sandboxWorkflow.ts, rule 1. */
const finalAnswer = sandboxFinalAnswer;

export interface SandboxActionResult {
  ok: boolean;
  error?: string;
}

export async function createSandboxSession(input: {
  label?: string;
  groupId?: string | null;
}): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
  const granted = await checkPermission("conversation_learning.manage");
  if ("denied" in granted) return { ok: false, error: granted.denied };
  const session = granted.session;

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
  const granted = await checkPermission("conversation_learning.manage");
  if ("denied" in granted) return { ok: false, error: granted.denied };

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
  const granted = await checkPermission("conversation_learning.manage");
  if ("denied" in granted) return { ok: false, error: granted.denied };
  const session = granted.session;

  const turn = await prisma.sandboxTurn.findUnique({
    where: { id: turnId },
    select: { id: true, status: true, review: true, responseText: true, editedResponseText: true, promotedKnowledgeItemId: true },
  });
  if (!turn) return { ok: false, error: "That answer no longer exists." };
  const allowed = canSetSandboxReview(turn, review);
  if (!allowed.ok) return { ok: false, error: allowed.reason };

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
 * Saves an admin's correction to an answer — or the admin's own answer, for a turn the AI handed
 * over without drafting one. `responseText` is never touched. Saving the AI's own words back
 * unchanged clears the edit rather than recording a correction that is not one.
 */
export async function saveSandboxEdit(
  turnId: string,
  text: string,
): Promise<{ ok: boolean; error?: string; reverified?: boolean }> {
  const granted = await checkPermission("conversation_learning.manage");
  if ("denied" in granted) return { ok: false, error: granted.denied };
  const session = granted.session;

  const answer = text.trim();
  if (!answer) return { ok: false, error: "The answer cannot be empty." };
  if (answer.length > MAX_ANSWER_LENGTH) {
    return { ok: false, error: `Keep the answer under ${MAX_ANSWER_LENGTH} characters — the knowledge base's own limit.` };
  }

  const turn = await prisma.sandboxTurn.findUnique({
    where: { id: turnId },
    select: { id: true, status: true, review: true, responseText: true, editedResponseText: true, promotedKnowledgeItemId: true },
  });
  if (!turn) return { ok: false, error: "That answer no longer exists." };
  const allowed = canEditSandboxAnswer(turn);
  if (!allowed.ok) return { ok: false, error: allowed.reason };

  // Rule 4 lives in applySandboxEdit: a verification applies to the words that were verified.
  const applied = applySandboxEdit(turn, answer);
  const isEdit = applied.editedResponseText !== null;
  await prisma.sandboxTurn.update({
    where: { id: turnId },
    data: {
      editedResponseText: applied.editedResponseText,
      editedById: isEdit ? session.userId : null,
      editedAt: isEdit ? new Date() : null,
      ...(applied.verificationWithdrawn ? { review: "WAITING" as const, reviewedById: null, reviewedAt: null } : {}),
    },
  });

  revalidatePath("/conversation-learning/sandbox");
  return { ok: true, reverified: applied.verificationWithdrawn };
}

export interface SimilarKnowledge {
  id: string;
  title: string;
  question: string | null;
  humanVerified: boolean;
  status: string;
}

/**
 * Knowledge entries that may already answer this question. Narrowed in SQL by the question's own
 * content words (the terms knowledge retrieval reads), then scored with `questionSimilarity` — so a
 * "duplicate" here is an entry that would compete with the new one for the same customer message.
 * Archived entries are left out; nothing is ever changed.
 */
async function findSimilarKnowledge(question: string): Promise<SimilarKnowledge[]> {
  const terms = deriveQueryTerms(question, 6);
  if (terms.length === 0) return [];
  const candidates = await prisma.aiKnowledgeItem.findMany({
    where: {
      status: { not: "ARCHIVED" },
      OR: terms.flatMap((term) => [
        { question: { contains: term, mode: "insensitive" as const } },
        { title: { contains: term, mode: "insensitive" as const } },
      ]),
    },
    select: { id: true, title: true, question: true, humanVerified: true, status: true },
    take: 300,
  });
  return candidates
    .map((item) => ({ item, score: questionSimilarity(question, item.question ?? item.title) }))
    .filter(({ score }) => score >= DUPLICATE_QUESTION_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ item }) => item);
}

export interface MakeKnowledgeResult {
  ok: boolean;
  error?: string;
  knowledgeItemId?: string;
  /** True when it was saved as verified; false when it went to Pending Review. */
  verified?: boolean;
  /** Possible duplicates — returned INSTEAD of creating, until the admin chooses to create anyway. */
  similar?: SimilarKnowledge[];
}

/**
 * The one door from the sandbox into the knowledge base.
 *
 * Only a VERIFIED turn goes through, only once, and it saves the question and answer as the admin
 * finally wrote them in the form — which default to the test question and the final answer. If the
 * admin changes the answer in the form, that becomes the turn's edited answer too, so the sandbox
 * and the knowledge entry never disagree about what was saved.
 *
 * VERIFIED OR PENDING REVIEW. Saving straight as verified knowledge (which the AI may then quote to
 * customers) needs `ai_learning.manage` — the same right that lets somebody type a verified entry on
 * the knowledge form or verify one in Pending Review. Without it the entry still lands, unverified,
 * in Pending Review, exactly as sandbox answers always did. A sandbox cannot grant a trust level the
 * user does not otherwise have.
 */
export async function makeKnowledgeFromSandbox(
  turnId: string,
  input: {
    title: string;
    category: string;
    question: string;
    answer: string;
    saveAsVerified: boolean;
    /** Set on the second press, after the admin has seen the similar entries. */
    allowDuplicate?: boolean;
  },
): Promise<MakeKnowledgeResult> {
  const granted = await checkPermission("conversation_learning.manage");
  if ("denied" in granted) return { ok: false, error: granted.denied };
  const session = granted.session;

  const title = input.title?.trim();
  const question = input.question?.trim();
  const answer = input.answer?.trim();
  if (!title) return { ok: false, error: "Give the knowledge entry a title." };
  if (!question) return { ok: false, error: "The question cannot be empty." };
  if (!answer) return { ok: false, error: "The answer cannot be empty." };
  if (answer.length > MAX_ANSWER_LENGTH) return { ok: false, error: `Keep the answer under ${MAX_ANSWER_LENGTH} characters.` };
  const category = isKnowledgeCategory(input.category) ? input.category : "FAQ";

  const turn = await prisma.sandboxTurn.findUnique({
    where: { id: turnId },
    select: {
      id: true,
      userMessage: true,
      responseText: true,
      editedResponseText: true,
      review: true,
      confidenceScore: true,
      promotedKnowledgeItemId: true,
      status: true,
      sessionId: true,
      session: { select: { groupId: true } },
    },
  });
  if (!turn) return { ok: false, error: "That answer no longer exists." };
  const allowed = canMakeSandboxKnowledge(turn);
  if (!allowed.ok) return { ok: false, error: allowed.reason };

  if (!input.allowDuplicate) {
    const similar = await findSimilarKnowledge(question);
    if (similar.length > 0) return { ok: false, similar };
  }

  const granted2 = new Set(await getGrantedPermissionKeys(session));
  const verified = input.saveAsVerified && granted2.has("ai_learning.manage");

  const aiAnswer = turn.responseText?.trim() ?? "";
  const editedByAdmin = answer !== aiAnswer;
  const now = new Date();

  const item = await prisma.$transaction(async (tx) => {
    const created = await tx.aiKnowledgeItem.create({
      data: {
        title,
        category,
        question,
        answer,
        source: "SANDBOX",
        sourceLabel: editedByAdmin ? "AI Sandbox — answer written or corrected by an admin" : "AI Sandbox — AI answer verified by an admin",
        sourceGroupId: turn.session.groupId,
        confidence: editedByAdmin ? null : turn.confidenceScore,
        // Honest about authorship: an answer the admin rewrote is theirs, not the model's.
        aiGenerated: !editedByAdmin,
        humanVerified: verified,
        verifiedById: verified ? session.userId : null,
        verifiedAt: verified ? now : null,
        scope: "GLOBAL",
        contentHash: knowledgeContentHash({ title, question, answer, procedure: null, module: null }),
        currentVersion: 1,
        createdById: session.userId,
        versions: {
          create: {
            version: 1,
            title,
            category,
            question,
            answer,
            changeSummary: editedByAdmin
              ? `Created from AI Sandbox (test conversation ${turn.sessionId}). Answer written or corrected by an admin; the original AI answer is kept on the sandbox turn.`
              : `Created from AI Sandbox (test conversation ${turn.sessionId}). AI answer verified by an admin without changes.`,
            createdById: session.userId,
          },
        },
      },
      select: { id: true },
    });
    await tx.sandboxTurn.update({
      where: { id: turnId },
      data: {
        promotedKnowledgeItemId: created.id,
        // The form's answer is the final answer now; record it on the turn so the two agree.
        ...(answer !== finalAnswer(turn)
          ? editedByAdmin
            ? { editedResponseText: answer, editedById: session.userId, editedAt: now }
            : { editedResponseText: null, editedById: null, editedAt: null }
          : {}),
      },
    });
    return created;
  });

  await logSystemEvent(
    "INFO",
    "ai-learning",
    `Knowledge "${title}" created from the AI Sandbox${verified ? " as verified" : " for review"}`,
    { itemId: item.id, sandboxTurnId: turnId, editedByAdmin, verified },
    { actorUserId: session.userId, targetType: "AiKnowledgeItem", targetId: item.id },
  );

  revalidatePath("/conversation-learning/sandbox");
  revalidatePath("/ai-learning/knowledge-base");
  revalidatePath("/ai-learning/knowledge-base/review");
  return { ok: true, knowledgeItemId: item.id, verified };
}

export async function deleteSandboxSession(sessionId: string): Promise<SandboxActionResult> {
  const granted = await checkPermission("conversation_learning.manage");
  if ("denied" in granted) return { ok: false, error: granted.denied };
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
