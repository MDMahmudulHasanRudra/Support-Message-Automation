"use server";

import { projectPath } from "@/server/projectPaths";
import { prisma } from "@/server/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import type { AiKnowledgeCategory, AiKnowledgeStatus } from "@prisma/client";
import { checkPermission, requireAccess } from "@/server/authorize";
import { logSystemEvent } from "@/server/logSystemEvent";
import { knowledgeContentHash } from "@support-automation/shared";

export interface KnowledgeFormState {
  error?: string;
  /**
   * A near-certain duplicate the operator has not yet chosen to accept. Not an error: two entries
   * can legitimately share a title, and only the person writing it knows whether this one is the
   * same fact restated or a genuinely different case.
   */
  duplicateWarning?: { message: string; existingId: string };
}

const CATEGORIES: AiKnowledgeCategory[] = [
  "SOFTWARE",
  "WORKFLOW",
  "FAQ",
  "TROUBLESHOOTING",
  "CUSTOMER_RESPONSE",
  "SOP",
  "REQUIREMENT",
  "FEATURE",
  "POLICY",
  "ANNOUNCEMENT",
  "SCREENSHOT",
];

function isCategory(value: string): value is AiKnowledgeCategory {
  return (CATEGORIES as string[]).includes(value);
}

interface ParsedFields {
  title: string;
  category: AiKnowledgeCategory;
  question: string | null;
  answer: string;
  procedure: string | null;
  software: string | null;
  module: string | null;
  softwareVersion: string | null;
}

function parseFields(formData: FormData): ParsedFields | { error: string } {
  const title = String(formData.get("title") ?? "").trim();
  const categoryRaw = String(formData.get("category") ?? "");
  const answer = String(formData.get("answer") ?? "").trim();

  if (!title) return { error: "Title is required." };
  if (!isCategory(categoryRaw)) return { error: "Invalid category." };
  if (!answer) return { error: "Answer is required." };

  const optional = (key: string) => String(formData.get(key) ?? "").trim() || null;

  return {
    title,
    category: categoryRaw,
    question: optional("question"),
    answer,
    procedure: optional("procedure"),
    software: optional("software"),
    module: optional("module"),
    softwareVersion: optional("softwareVersion"),
  };
}

export async function createKnowledgeItem(
  _prevState: KnowledgeFormState,
  formData: FormData,
): Promise<KnowledgeFormState> {
  const granted = await checkPermission("ai_learning.manage");
  if ("denied" in granted) return { error: granted.denied };
  const session = granted.session;
  const parsed = parseFields(formData);
  if ("error" in parsed) return parsed;

  // Checked before creating, and only once: a second submit carries allowDuplicate and goes
  // through. The knowledge base is retrieved by keyword overlap, so two entries answering the
  // same question compete with each other and whichever wins is effectively arbitrary — worth a
  // sentence of warning, not worth blocking, since a duplicate is sometimes the right call.
  if (formData.get("allowDuplicate") !== "on") {
    const existing = await prisma.aiKnowledgeItem.findFirst({
      where: { title: { equals: parsed.title, mode: "insensitive" }, status: { not: "ARCHIVED" } },
      orderBy: { updatedAt: "desc" },
      select: { id: true, title: true, humanVerified: true },
    });
    if (existing) {
      return {
        duplicateWarning: {
          existingId: existing.id,
          message: `An entry titled "${existing.title}" already exists${existing.humanVerified ? " and is verified" : " and is waiting for review"}. Check it first — editing that one keeps its history together. Submit again to create this as a separate entry anyway.`,
        },
      };
    }
  }

  const item = await prisma.aiKnowledgeItem.create({
    data: {
      ...parsed,
      source: "MANUAL",
      aiGenerated: false,
      humanVerified: true,
      // A person typed this into the knowledge form, so they are its verifier as well as its
      // author — recorded rather than implied.
      verifiedById: session.userId,
      verifiedAt: new Date(),
      // GLOBAL by construction: a manual entry carries no group, so there is nothing to narrow it
      // to. The default would give the same answer; stating it keeps the reasoning where the row
      // is written.
      scope: "GLOBAL",
      contentHash: knowledgeContentHash(parsed),
      currentVersion: 1,
      createdById: session.userId,
      versions: {
        create: {
          version: 1,
          title: parsed.title,
          category: parsed.category,
          question: parsed.question,
          answer: parsed.answer,
          procedure: parsed.procedure,
          software: parsed.software,
          module: parsed.module,
          softwareVersion: parsed.softwareVersion,
          changeSummary: "Created.",
          createdById: session.userId,
        },
      },
    },
  });

  await logSystemEvent(
    "INFO",
    "ai-learning",
    `Knowledge item "${parsed.title}" created`,
    { itemId: item.id },
    { actorUserId: session.userId, targetType: "AiKnowledgeItem", targetId: item.id },
  );
  revalidatePath(await projectPath("/ai-learning/knowledge-base"));
  redirect(await projectPath(`/ai-learning/knowledge-base/${item.id}`));
}

export async function updateKnowledgeItem(
  id: string,
  _prevState: KnowledgeFormState,
  formData: FormData,
): Promise<KnowledgeFormState> {
  const granted = await checkPermission("ai_learning.manage");
  if ("denied" in granted) return { error: granted.denied };
  const session = granted.session;
  const item = await prisma.aiKnowledgeItem.findUnique({ where: { id } });
  if (!item) return { error: "Knowledge item not found." };

  const parsed = parseFields(formData);
  if ("error" in parsed) return parsed;

  const changeSummary = String(formData.get("changeSummary") ?? "").trim() || "Edited.";
  const nextVersion = item.currentVersion + 1;

  await prisma.$transaction([
    prisma.aiKnowledgeVersion.create({
      data: {
        itemId: id,
        version: nextVersion,
        title: parsed.title,
        category: parsed.category,
        question: parsed.question,
        answer: parsed.answer,
        procedure: parsed.procedure,
        software: parsed.software,
        module: parsed.module,
        softwareVersion: parsed.softwareVersion,
        changeSummary,
        createdById: session.userId,
      },
    }),
    prisma.aiKnowledgeItem.update({
      where: { id },
      // The hash follows the content, so "has this changed since it was verified?" stays
      // answerable. Recomputed in the same transaction as the version row, because the two
      // describe the same edit and must not be able to disagree.
      data: { ...parsed, currentVersion: nextVersion, contentHash: knowledgeContentHash(parsed) },
    }),
  ]);

  await logSystemEvent(
    "INFO",
    "ai-learning",
    `Knowledge item "${parsed.title}" edited (v${nextVersion})`,
    { itemId: id, version: nextVersion },
    { actorUserId: session.userId, targetType: "AiKnowledgeItem", targetId: id },
  );
  revalidatePath(await projectPath(`/ai-learning/knowledge-base/${id}`));
  revalidatePath(await projectPath("/ai-learning/knowledge-base"));
  redirect(await projectPath(`/ai-learning/knowledge-base/${id}`));
}

/**
 * Marks a knowledge entry as checked by a person, or sends it back for review.
 *
 * Entries written by the group knowledge builder arrive `humanVerified: false` on purpose — a
 * model's reading of a chat log is evidence, not fact. Without this action the review queue had
 * no exit and every distilled entry would sit as "Needs review" forever, which is worse than not
 * flagging them at all: a warning nobody can clear stops being read.
 *
 * Deliberately separate from status: an entry can be ACTIVE and unverified (it is being used, but
 * nobody has confirmed it), or verified and INACTIVE (checked, but deliberately not in play).
 */
export async function setKnowledgeVerified(id: string, verified: boolean): Promise<void> {
  const session = await requireAccess("ai_learning.manage");
  const item = await prisma.aiKnowledgeItem.update({
    where: { id },
    data: {
      humanVerified: verified,
      // Cleared on UNverify, not left behind. A stale "verified by X on the 3rd" beside
      // `humanVerified: false` reads as a contradiction, and the approval it describes has been
      // withdrawn — the record of it belongs in the log, which keeps both events.
      verifiedById: verified ? session.userId : null,
      verifiedAt: verified ? new Date() : null,
    },
    select: { title: true },
  });

  await logSystemEvent(
    "INFO",
    "ai-learning",
    `Knowledge item "${item.title}" marked ${verified ? "verified" : "unverified"}`,
    { itemId: id },
    { actorUserId: session.userId, targetType: "AiKnowledgeItem", targetId: id },
  );

  revalidatePath(await projectPath("/ai-learning/knowledge-base"));
  revalidatePath(await projectPath(`/ai-learning/knowledge-base/${id}`));
}

/**
 * A ceiling on one bulk VERIFICATION, not a technical limit.
 *
 * Verifying is the moment an entry becomes something the system will say to a customer, so the
 * bulk control exists to spare a reviewer twenty round trips through a single import — not to
 * make "verify everything" a one-click habit. A cap keeps the action the size of a queue page.
 */
const MAX_BULK_VERIFY_IDS = 100;

/**
 * Status changes and deletes get their own, larger ceiling, and the split is not cosmetic.
 *
 * One cap of 100 covered every bulk action, which was right while verification was the only one.
 * Once the list offered 500- and 1,000-row pages, "select all on this page" then made *archiving*
 * fail with the verifier's own wording — a refusal that made no sense for the action requested and
 * which no amount of re-reading the page would explain. These three move an entry between ACTIVE,
 * INACTIVE and ARCHIVED, or remove it; none of them is the gate in front of a customer, so the
 * honest bound is the largest page the operator can actually select, not the reviewer's ceiling.
 */
const MAX_BULK_STATUS_IDS = 1000;

export interface BulkKnowledgeResult {
  updated: number;
  /** Selected but already in the requested end state — a no-op write, not a failure. */
  alreadyInTargetState?: number;
  /** Selected but gone by the time this ran (e.g. deleted from another tab). */
  notFound?: number;
  /** Selected but already discarded. Reported separately rather than folded into "already there",
   *  because a stale selection reaching an archived entry is worth seeing, not smoothing over. */
  skippedArchived?: number;
  /** Actionable prose for the operator; the caller shows it as-is. */
  error?: string;
}

function normalizeBulkIds(ids: string[]): string[] {
  return Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
}

/**
 * `overLimitHint` is per-action rather than one shared sentence, because the reason for each
 * ceiling is different and a refusal that explains the wrong one is worse than a bare error.
 */
function checkBulkIds(
  ids: string[],
  max: number,
  overLimitHint: string,
): { ids: string[] } | BulkKnowledgeResult {
  const unique = normalizeBulkIds(ids);
  if (unique.length === 0) return { updated: 0, error: "Select at least one entry first." };
  if (unique.length > max) {
    return { updated: 0, error: `That is ${unique.length} entries at once, over the limit of ${max}. ${overLimitHint}` };
  }
  return { ids: unique };
}

const VERIFY_LIMIT_HINT =
  "Work through them a page at a time — verifying is what lets an entry answer a customer.";
const STATUS_LIMIT_HINT = "Narrow the filters, or use a smaller page size, and run it again.";

/**
 * Verifies several entries at once.
 *
 * An importer can now produce a hundred entries in one afternoon, and a queue that can only be
 * cleared one entry at a time is a queue that stops being cleared — which would leave verified
 * retrieval starved while the review backlog grew. Already-verified and archived rows are
 * excluded by the `where` rather than by the caller, so a stale selection can neither resurrect a
 * discarded entry nor inflate the reported count.
 */
export async function bulkSetKnowledgeVerified(ids: string[]): Promise<BulkKnowledgeResult> {
  const granted = await checkPermission("ai_learning.manage");
  if ("denied" in granted) return { updated: 0, error: granted.denied };
  const session = granted.session;
  const checked = checkBulkIds(ids, MAX_BULK_VERIFY_IDS, VERIFY_LIMIT_HINT);
  if (!("ids" in checked)) return checked;

  // Read first, so the result can say WHICH of the selected rows moved. The `where` below already
  // excluded already-verified and archived rows silently, which meant "verify these 20" could
  // verify fourteen and report nothing at all — the exact "Done" that the bulk-action standard
  // exists to forbid.
  const existing = await prisma.aiKnowledgeItem.findMany({
    where: { id: { in: checked.ids } },
    select: { id: true, humanVerified: true, status: true },
  });
  const notFound = checked.ids.length - existing.length;
  const skippedArchived = existing.filter((item) => item.status === "ARCHIVED").length;
  const alreadyInTargetState = existing.filter(
    (item) => item.status !== "ARCHIVED" && item.humanVerified,
  ).length;

  const { count } = await prisma.aiKnowledgeItem.updateMany({
    where: { id: { in: checked.ids }, humanVerified: false, status: { not: "ARCHIVED" } },
    // Who approved this, and when. `humanVerified` is the single gate between the knowledge base
    // and what a customer is told, and it recorded only THAT somebody approved — which leaves the
    // safety chain unauditable at exactly the point it matters most.
    data: { humanVerified: true, verifiedById: session.userId, verifiedAt: new Date() },
  });

  await logSystemEvent(
    "INFO",
    "ai-learning",
    `${count} knowledge entries verified`,
    { count, itemIds: checked.ids },
    // The actor moves out of `metadata` and into a real column: a JSON blob cannot be indexed,
    // filtered or joined, so "everything this person approved" was not a question the log could
    // answer.
    { actorUserId: session.userId, targetType: "AiKnowledgeItem" },
  );
  revalidatePath(await projectPath("/ai-learning/knowledge-base/review"));
  revalidatePath(await projectPath("/ai-learning/knowledge-base"));
  return { updated: count, alreadyInTargetState, notFound, skippedArchived };
}

/** Discards several entries at once — archived, never deleted, exactly like the single-entry path. */
export async function bulkArchiveKnowledge(ids: string[]): Promise<BulkKnowledgeResult> {
  const granted = await checkPermission("ai_learning.manage");
  if ("denied" in granted) return { updated: 0, error: granted.denied };
  const session = granted.session;
  const checked = checkBulkIds(ids, MAX_BULK_STATUS_IDS, STATUS_LIMIT_HINT);
  if (!("ids" in checked)) return checked;

  const existing = await prisma.aiKnowledgeItem.findMany({
    where: { id: { in: checked.ids } },
    select: { id: true, status: true },
  });
  const notFound = checked.ids.length - existing.length;
  const alreadyInTargetState = existing.filter((item) => item.status === "ARCHIVED").length;

  const { count } = await prisma.aiKnowledgeItem.updateMany({
    where: { id: { in: checked.ids }, status: { not: "ARCHIVED" } },
    // ARCHIVED, not deleted: what a model got wrong is itself evidence, and this codebase
    // soft-deletes anything with historical value.
    data: { status: "ARCHIVED" },
  });

  await logSystemEvent("INFO", "ai-learning", `${count} knowledge entries discarded (archived)`, {
    count,
    itemIds: checked.ids,
    userId: session.userId,
  });
  revalidatePath(await projectPath("/ai-learning/knowledge-base/review"));
  revalidatePath(await projectPath("/ai-learning/knowledge-base"));
  return { updated: count, alreadyInTargetState, notFound };
}

export async function setKnowledgeStatus(id: string, status: AiKnowledgeStatus): Promise<void> {
  await requireAccess("ai_learning.manage");
  const item = await prisma.aiKnowledgeItem.update({ where: { id }, data: { status } });
  await logSystemEvent("INFO", "ai-learning", `Knowledge item "${item.title}" set to ${status}`, { itemId: id });
  revalidatePath(await projectPath(`/ai-learning/knowledge-base/${id}`));
  revalidatePath(await projectPath("/ai-learning/knowledge-base"));
}

/**
 * Bulk status change for the main Knowledge Base table — Active, Inactive or Archived in one
 * action, for the same reason bulkSetMonitoring exists for groups: a hundred entries from one
 * import is a hundred clicks otherwise.
 *
 * Deliberately never touches `humanVerified` — that is a separate axis (an entry can be ACTIVE
 * and unverified, or verified and INACTIVE) — and reads current status first so the report can
 * tell "genuinely changed" from "already there", per ENGINEERING_STANDARDS.md's bulk-action rule.
 */
export async function bulkSetKnowledgeStatus(ids: string[], status: AiKnowledgeStatus): Promise<BulkKnowledgeResult> {
  const granted = await checkPermission("ai_learning.manage");
  if ("denied" in granted) return { updated: 0, error: granted.denied };
  const session = granted.session;
  const checked = checkBulkIds(ids, MAX_BULK_STATUS_IDS, STATUS_LIMIT_HINT);
  if (!("ids" in checked)) return checked;

  const existing = await prisma.aiKnowledgeItem.findMany({
    where: { id: { in: checked.ids } },
    select: { id: true, status: true },
  });
  const existingIds = new Set(existing.map((item) => item.id));
  const notFound = checked.ids.filter((id) => !existingIds.has(id)).length;
  const idsToChange = existing.filter((item) => item.status !== status).map((item) => item.id);
  const alreadyInTargetState = existing.length - idsToChange.length;

  let updated = 0;
  if (idsToChange.length > 0) {
    const result = await prisma.aiKnowledgeItem.updateMany({
      where: { id: { in: idsToChange } },
      data: { status },
    });
    updated = result.count;

    await logSystemEvent(
      "INFO",
      "ai-learning",
      `${updated} knowledge entries set to ${status}`,
      { count: updated, itemIds: idsToChange, status },
      { actorUserId: session.userId, targetType: "AiKnowledgeItem" },
    );
  }

  revalidatePath(await projectPath("/ai-learning/knowledge-base"));
  return { updated, alreadyInTargetState, notFound };
}

/**
 * Permanently removes selected entries — the one irreversible action in this file. Every other
 * discard path here archives instead, per this codebase's soft-delete-first rule; this exists
 * because an operator also needs to clean up genuine junk (a duplicate created by mistake, a test
 * entry) with no history worth keeping, and "Archived" would leave it cluttering that filter
 * forever. `AiKnowledgeVersion` cascades with its item; `AiFallbackDecision.knowledgeItemId` is
 * `SetNull`, so a past AI answer keeps its own audit record and is never silently deleted just
 * because the entry it cited was.
 */
export async function bulkDeleteKnowledge(ids: string[]): Promise<BulkKnowledgeResult> {
  const granted = await checkPermission("ai_learning.manage");
  if ("denied" in granted) return { updated: 0, error: granted.denied };
  const session = granted.session;
  const checked = checkBulkIds(ids, MAX_BULK_STATUS_IDS, STATUS_LIMIT_HINT);
  if (!("ids" in checked)) return checked;

  const existing = await prisma.aiKnowledgeItem.findMany({
    where: { id: { in: checked.ids } },
    select: { id: true, title: true },
  });
  const notFound = checked.ids.length - existing.length;
  if (existing.length === 0) {
    return { updated: 0, notFound, error: "None of the selected entries exist anymore." };
  }

  const { count } = await prisma.aiKnowledgeItem.deleteMany({
    where: { id: { in: existing.map((item) => item.id) } },
  });

  await logSystemEvent(
    "INFO",
    "ai-learning",
    `${count} knowledge entries permanently deleted`,
    { count, itemIds: existing.map((item) => item.id), titles: existing.map((item) => item.title) },
    { actorUserId: session.userId, targetType: "AiKnowledgeItem" },
  );

  revalidatePath(await projectPath("/ai-learning/knowledge-base"));
  return { updated: count, notFound };
}

/** Restoring never deletes history — it adds a new version copying the old one's content, same as any other edit. */
export async function restoreKnowledgeVersion(itemId: string, version: number): Promise<void> {
  const session = await requireAccess("ai_learning.manage");
  const item = await prisma.aiKnowledgeItem.findUnique({ where: { id: itemId } });
  const target = await prisma.aiKnowledgeVersion.findUnique({ where: { itemId_version: { itemId, version } } });
  if (!item || !target) return;

  const nextVersion = item.currentVersion + 1;
  await prisma.$transaction([
    prisma.aiKnowledgeVersion.create({
      data: {
        itemId,
        version: nextVersion,
        title: target.title,
        category: target.category,
        question: target.question,
        answer: target.answer,
        procedure: target.procedure,
        software: target.software,
        module: target.module,
        softwareVersion: target.softwareVersion,
        changeSummary: `Restored from version ${version}.`,
        createdById: session.userId,
      },
    }),
    prisma.aiKnowledgeItem.update({
      where: { id: itemId },
      data: {
        title: target.title,
        category: target.category,
        question: target.question,
        answer: target.answer,
        procedure: target.procedure,
        software: target.software,
        module: target.module,
        softwareVersion: target.softwareVersion,
        currentVersion: nextVersion,
      },
    }),
  ]);

  await logSystemEvent("INFO", "ai-learning", `Knowledge item "${target.title}" restored from v${version}`, {
    itemId,
  });
  revalidatePath(await projectPath(`/ai-learning/knowledge-base/${itemId}`));
}

/**
 * Changes who a knowledge entry is true for.
 *
 * The way out of GROUP, and the reason narrowing by provenance is safe rather than a one-way door.
 * An entry distilled from one conversation starts GROUP because that is all anyone knows about it;
 * a person who reads it and judges it true of the PRODUCT rather than of that customer promotes it,
 * and it becomes retrievable everywhere. Without this the safe default would be a trap — knowledge
 * would accumulate that could never be shared.
 *
 * Deliberately a separate action from verification. They answer different questions — "is this
 * true?" and "who is it true for?" — and a reviewer can easily be sure of one and not the other.
 * Bundling them would make every approval an implicit decision about scope.
 */
export async function setKnowledgeScope(
  id: string,
  scope: "GLOBAL" | "GROUP" | "ACCOUNT",
  scopeAccountId?: string | null,
): Promise<{ error?: string }> {
  const granted = await checkPermission("ai_learning.manage");
  if ("denied" in granted) return { error: granted.denied };
  const session = granted.session;

  // ACCOUNT without an account is unreachable by construction — it would match nothing and read as
  // a silent archive rather than a scope change.
  if (scope === "ACCOUNT" && !scopeAccountId) {
    return { error: "Choose which WhatsApp account this knowledge applies to." };
  }

  const existing = await prisma.aiKnowledgeItem.findUnique({
    where: { id },
    select: { title: true, scope: true, sourceGroupId: true },
  });
  if (!existing) return { error: "That knowledge entry no longer exists." };

  // GROUP needs a group to be narrowed to. An entry with no provenance cannot be scoped to one,
  // and storing GROUP with a null `sourceGroupId` would make it permanently unretrievable.
  if (scope === "GROUP" && !existing.sourceGroupId) {
    return { error: "This entry did not come from a group, so it cannot be limited to one." };
  }

  await prisma.aiKnowledgeItem.update({
    where: { id },
    data: { scope, scopeAccountId: scope === "ACCOUNT" ? (scopeAccountId ?? null) : null },
  });

  // Audited, because widening scope is the one edit here that changes WHO can be told something.
  await logSystemEvent(
    "INFO",
    "ai-learning",
    `Knowledge item "${existing.title}" scope changed from ${existing.scope} to ${scope}`,
    { itemId: id, from: existing.scope, to: scope },
    { actorUserId: session.userId, targetType: "AiKnowledgeItem", targetId: id },
  );

  revalidatePath(await projectPath("/ai-learning/knowledge-base"));
  revalidatePath(await projectPath(`/ai-learning/knowledge-base/${id}`));
  return {};
}
