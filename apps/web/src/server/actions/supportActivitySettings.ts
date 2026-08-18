"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@support-automation/db";
import type { SupportActivityCountingMode } from "@prisma/client";
import { requireSession } from "@/server/auth";

async function getOrCreateSupportActivitySettings() {
  return prisma.supportActivitySettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
}

export async function setSupportActivityEnabled(enabled: boolean): Promise<void> {
  await requireSession();
  await getOrCreateSupportActivitySettings();
  await prisma.supportActivitySettings.update({ where: { id: "global" }, data: { enabled } });
  revalidatePath("/support-activity");
  revalidatePath("/support-activity/settings");
  revalidatePath("/overview");
}

const VALID_MODES: SupportActivityCountingMode[] = ["UNIQUE_GROUP", "EVERY_ACTIVITY", "PER_TEAM_MEMBER"];

export async function updateSupportActivityCounting(countingMode: string): Promise<void> {
  await requireSession();
  if (!VALID_MODES.includes(countingMode as SupportActivityCountingMode)) {
    throw new Error("Invalid counting mode.");
  }
  await getOrCreateSupportActivitySettings();
  await prisma.supportActivitySettings.update({
    where: { id: "global" },
    data: { countingMode: countingMode as SupportActivityCountingMode },
  });
  revalidatePath("/support-activity");
  revalidatePath("/support-activity/settings");
}

export async function updateSupportActivitySettings(formData: FormData): Promise<void> {
  await requireSession();
  const enabled = formData.get("enabled") === "on";
  const countingMode = String(formData.get("countingMode") ?? "EVERY_ACTIVITY");
  if (!VALID_MODES.includes(countingMode as SupportActivityCountingMode)) {
    throw new Error("Invalid counting mode.");
  }

  await getOrCreateSupportActivitySettings();
  await prisma.supportActivitySettings.update({
    where: { id: "global" },
    data: { enabled, countingMode: countingMode as SupportActivityCountingMode },
  });
  revalidatePath("/support-activity");
  revalidatePath("/support-activity/settings");
  revalidatePath("/overview");
}
