"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@support-automation/db";
import type { AiKnowledgeCategory, AiKnowledgeStatus } from "@prisma/client";
import { requireSession } from "@/server/auth";
import { logSystemEvent } from "@/server/logSystemEvent";

export interface KnowledgeFormState {
  error?: string;
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
