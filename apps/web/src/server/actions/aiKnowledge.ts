"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@support-automation/db";
import type { AiKnowledgeCategory, AiKnowledgeStatus } from "@prisma/client";
import { requireSession } from "@/server/auth";
import { logSystemEvent } from "@/server/logSystemEvent";

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
  const session = await requireSession();
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

  await logSystemEvent("INFO", "ai-learning", `Knowledge item "${parsed.title}" created`, { itemId: item.id });
  revalidatePath("/ai-learning/knowledge-base");
  redirect(`/ai-learning/knowledge-base/${item.id}`);
}

export async function updateKnowledgeItem(
  id: string,
  _prevState: KnowledgeFormState,
  formData: FormData,
): Promise<KnowledgeFormState> {
  const session = await requireSession();
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
      data: { ...parsed, currentVersion: nextVersion },
    }),
  ]);

  await logSystemEvent("INFO", "ai-learning", `Knowledge item "${parsed.title}" edited (v${nextVersion})`, {
    itemId: id,
  });
  revalidatePath(`/ai-learning/knowledge-base/${id}`);
  revalidatePath("/ai-learning/knowledge-base");
  redirect(`/ai-learning/knowledge-base/${id}`);
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
  const session = await requireSession();
  const item = await prisma.aiKnowledgeItem.update({
    where: { id },
    data: { humanVerified: verified },
    select: { title: true },
  });

  await logSystemEvent(
    "INFO",
    "ai-learning",
    `Knowledge item "${item.title}" marked ${verified ? "verified" : "unverified"}`,
    { itemId: id, userId: session.userId },
  );

  revalidatePath("/ai-learning/knowledge-base");
  revalidatePath(`/ai-learning/knowledge-base/${id}`);
}

/**
 * A ceiling on one bulk action, not a technical limit.
 *
 * Verifying is the moment an entry becomes something the system will say to a customer, so the
 * bulk control exists to spare a reviewer twenty round trips through a single import — not to
 * make "verify everything" a one-click habit. A cap keeps the action the size of a queue page.
 */
const MAX_BULK_KNOWLEDGE_IDS = 100;

export interface BulkKnowledgeResult {
  updated: number;
  /** Actionable prose for the operator; the caller shows it as-is. */
  error?: string;
}

function normalizeBulkIds(ids: string[]): string[] {
  return Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
}

function checkBulkIds(ids: string[]): { ids: string[] } | BulkKnowledgeResult {
  const unique = normalizeBulkIds(ids);
  if (unique.length === 0) return { updated: 0, error: "Select at least one entry first." };
  if (unique.length > MAX_BULK_KNOWLEDGE_IDS) {
    return {
      updated: 0,
      error: `That is ${unique.length} entries at once, over the limit of ${MAX_BULK_KNOWLEDGE_IDS}. Work through them a page at a time — verifying is what lets an entry answer a customer.`,
    };
  }
  return { ids: unique };
}

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
  const session = await requireSession();
  const checked = checkBulkIds(ids);
  if (!("ids" in checked)) return checked;

  const { count } = await prisma.aiKnowledgeItem.updateMany({
    where: { id: { in: checked.ids }, humanVerified: false, status: { not: "ARCHIVED" } },
    data: { humanVerified: true },
  });

  await logSystemEvent("INFO", "ai-learning", `${count} knowledge entries verified`, {
    count,
    itemIds: checked.ids,
    userId: session.userId,
  });
  revalidatePath("/ai-learning/knowledge-base/review");
  revalidatePath("/ai-learning/knowledge-base");
  return { updated: count };
}

/** Discards several entries at once — archived, never deleted, exactly like the single-entry path. */
export async function bulkArchiveKnowledge(ids: string[]): Promise<BulkKnowledgeResult> {
  const session = await requireSession();
  const checked = checkBulkIds(ids);
  if (!("ids" in checked)) return checked;

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
  revalidatePath("/ai-learning/knowledge-base/review");
  revalidatePath("/ai-learning/knowledge-base");
  return { updated: count };
}

export async function setKnowledgeStatus(id: string, status: AiKnowledgeStatus): Promise<void> {
  await requireSession();
  const item = await prisma.aiKnowledgeItem.update({ where: { id }, data: { status } });
  await logSystemEvent("INFO", "ai-learning", `Knowledge item "${item.title}" set to ${status}`, { itemId: id });
  revalidatePath(`/ai-learning/knowledge-base/${id}`);
  revalidatePath("/ai-learning/knowledge-base");
}

/** Restoring never deletes history — it adds a new version copying the old one's content, same as any other edit. */
export async function restoreKnowledgeVersion(itemId: string, version: number): Promise<void> {
  const session = await requireSession();
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
  revalidatePath(`/ai-learning/knowledge-base/${itemId}`);
}
