"use server";

import { projectPath } from "@/server/projectPaths";
import { prisma } from "@/server/db";
import { revalidatePath } from "next/cache";

import type { SupportKeywordMatchMode } from "@prisma/client";
import { requireAccess } from "@/server/authorize";

export async function createSupportKeyword(formData: FormData): Promise<void> {
  await requireAccess("support_activity.manage");
  const value = String(formData.get("value") ?? "").trim();
  const matchMode = String(formData.get("matchMode") ?? "CONTAINS") as SupportKeywordMatchMode;
  const caseSensitive = formData.get("caseSensitive") === "on";
  const marksCompletion = formData.get("marksCompletion") === "on";

  if (!value) throw new Error("Keyword value is required.");

  await prisma.supportKeyword.create({ data: { value, matchMode, caseSensitive, marksCompletion, isActive: true } });
  revalidatePath(await projectPath("/support-activity/keywords"));
}

export async function updateSupportKeyword(id: string, formData: FormData): Promise<void> {
  await requireAccess("support_activity.manage");
  const value = String(formData.get("value") ?? "").trim();
  const matchMode = String(formData.get("matchMode") ?? "CONTAINS") as SupportKeywordMatchMode;
  const caseSensitive = formData.get("caseSensitive") === "on";
  const marksCompletion = formData.get("marksCompletion") === "on";

  if (!value) throw new Error("Keyword value is required.");

  await prisma.supportKeyword.update({ where: { id }, data: { value, matchMode, caseSensitive, marksCompletion } });
  revalidatePath(await projectPath("/support-activity/keywords"));
}

export async function toggleSupportKeywordActive(id: string): Promise<void> {
  await requireAccess("support_activity.manage");
  const keyword = await prisma.supportKeyword.findUniqueOrThrow({ where: { id } });
  await prisma.supportKeyword.update({ where: { id }, data: { isActive: !keyword.isActive } });
  revalidatePath(await projectPath("/support-activity/keywords"));
}

export async function deleteSupportKeyword(id: string): Promise<void> {
  await requireAccess("support_activity.manage");
  await prisma.supportKeyword.delete({ where: { id } });
  revalidatePath(await projectPath("/support-activity/keywords"));
}
