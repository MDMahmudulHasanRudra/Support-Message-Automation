"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@support-automation/db";
import type { SupportActivityCountingPeriod } from "@prisma/client";
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

export async function updateSupportActivitySettings(formData: FormData): Promise<void> {
  await requireSession();
  const enabled = formData.get("enabled") === "on";
  // Clamped rather than rejected: this is a tuning number, and bouncing the whole form over it
  // would discard the other fields somebody had just set.
  const rawOffline = Number(formData.get("offlineAfterMinutes"));
  const offlineAfterMinutes = Number.isFinite(rawOffline)
    ? Math.min(1440, Math.max(5, Math.round(rawOffline)))
    : 120;

  const countingPeriod = String(formData.get("countingPeriod") ?? "DAILY");
  if (!VALID_PERIODS.includes(countingPeriod as SupportActivityCountingPeriod)) {
    throw new Error("Invalid counting period.");
  }

  await getOrCreateSupportActivitySettings();
  await prisma.supportActivitySettings.update({
    where: { id: "global" },
    data: {
      enabled,
      offlineAfterMinutes,
      countingPeriod: countingPeriod as SupportActivityCountingPeriod,
    },
  });
  revalidatePath("/support-activity");
  revalidatePath("/support-activity/team");
  revalidatePath("/support-activity/settings");
  revalidatePath("/overview");
}
