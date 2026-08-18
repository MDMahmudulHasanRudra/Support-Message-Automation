"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@support-automation/db";
import type { SupportActivityCountingMode, SupportActivityCountingPeriod } from "@prisma/client";
import { requireSession } from "@/server/auth";

const VALID_PERIODS: SupportActivityCountingPeriod[] = ["DAILY", "WEEKLY", "MONTHLY"];

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
  const countingPeriod = String(formData.get("countingPeriod") ?? "DAILY");
  if (!VALID_PERIODS.includes(countingPeriod as SupportActivityCountingPeriod)) {
    throw new Error("Invalid counting period.");
  }

  await getOrCreateSupportActivitySettings();
  await prisma.supportActivitySettings.update({
    where: { id: "global" },
    data: {
      enabled,
      countingMode: countingMode as SupportActivityCountingMode,
      countingPeriod: countingPeriod as SupportActivityCountingPeriod,
    },
  });
  revalidatePath("/support-activity");
  revalidatePath("/support-activity/team");
  revalidatePath("/support-activity/settings");
  revalidatePath("/overview");
}
