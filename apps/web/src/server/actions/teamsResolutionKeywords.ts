"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@support-automation/db";
import type { SupportKeywordMatchMode } from "@prisma/client";
import { requireSession } from "@/server/auth";

/** Mirrors supportKeywords.ts exactly (same CRUD shape) — reuses the same
 * SupportKeywordMatchMode enum and matchSupportKeyword() matcher, just for a different
 * admin-managed keyword list (Teams resolution keywords rather than Support Activity keywords). */

export async function createTeamsResolutionKeyword(formData: FormData): Promise<void> {
  await requireSession();
  const value = String(formData.get("value") ?? "").trim();
  const matchMode = String(formData.get("matchMode") ?? "CONTAINS") as SupportKeywordMatchMode;
  const caseSensitive = formData.get("caseSensitive") === "on";

  if (!value) throw new Error("Keyword value is required.");

  await prisma.teamsResolutionKeyword.create({ data: { value, matchMode, caseSensitive, isActive: true } });
  revalidatePath("/integrations/teams/keywords");
}

export async function updateTeamsResolutionKeyword(id: string, formData: FormData): Promise<void> {
  await requireSession();
  const value = String(formData.get("value") ?? "").trim();
  const matchMode = String(formData.get("matchMode") ?? "CONTAINS") as SupportKeywordMatchMode;
  const caseSensitive = formData.get("caseSensitive") === "on";

  if (!value) throw new Error("Keyword value is required.");

  await prisma.teamsResolutionKeyword.update({ where: { id }, data: { value, matchMode, caseSensitive } });
  revalidatePath("/integrations/teams/keywords");
}

export async function toggleTeamsResolutionKeywordActive(id: string): Promise<void> {
  await requireSession();
  const keyword = await prisma.teamsResolutionKeyword.findUniqueOrThrow({ where: { id } });
  await prisma.teamsResolutionKeyword.update({ where: { id }, data: { isActive: !keyword.isActive } });
  revalidatePath("/integrations/teams/keywords");
}

export async function deleteTeamsResolutionKeyword(id: string): Promise<void> {
  await requireSession();
  await prisma.teamsResolutionKeyword.delete({ where: { id } });
  revalidatePath("/integrations/teams/keywords");
}
