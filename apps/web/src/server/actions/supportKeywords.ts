"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@support-automation/db";
import type { SupportKeywordMatchMode } from "@prisma/client";
import { requireSession } from "@/server/auth";

export async function createSupportKeyword(formData: FormData): Promise<void> {
  await requireSession();
  const value = String(formData.get("value") ?? "").trim();
  const matchMode = String(formData.get("matchMode") ?? "CONTAINS") as SupportKeywordMatchMode;
  const caseSensitive = formData.get("caseSensitive") === "on";
  const marksCompletion = formData.get("marksCompletion") === "on";

  if (!value) throw new Error("Keyword value is required.");

  await prisma.supportKeyword.create({ data: { value, matchMode, caseSensitive, marksCompletion, isActive: true } });
  revalidatePath("/support-activity/keywords");
}

export async function updateSupportKeyword(id: string, formData: FormData): Promise<void> {
  await requireSession();
  const value = String(formData.get("value") ?? "").trim();
  const matchMode = String(formData.get("matchMode") ?? "CONTAINS") as SupportKeywordMatchMode;
  const caseSensitive = formData.get("caseSensitive") === "on";
  const marksCompletion = formData.get("marksCompletion") === "on";

  if (!value) throw new Error("Keyword value is required.");

  await prisma.supportKeyword.update({ where: { id }, data: { value, matchMode, caseSensitive, marksCompletion } });
  revalidatePath("/support-activity/keywords");
}

export async function toggleSupportKeywordActive(id: string): Promise<void> {
  await requireSession();
  const keyword = await prisma.supportKeyword.findUniqueOrThrow({ where: { id } });
  await prisma.supportKeyword.update({ where: { id }, data: { isActive: !keyword.isActive } });
  revalidatePath("/support-activity/keywords");
}

export async function deleteSupportKeyword(id: string): Promise<void> {
  await requireSession();
  await prisma.supportKeyword.delete({ where: { id } });
  revalidatePath("/support-activity/keywords");
}
