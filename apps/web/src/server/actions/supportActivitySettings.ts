"use server";

import { projectPath } from "@/server/projectPaths";
import { prisma } from "@/server/db";
import { revalidatePath } from "next/cache";

import type { SupportActivityCountingPeriod } from "@prisma/client";
import { requireAccess } from "@/server/authorize";

const VALID_PERIODS: SupportActivityCountingPeriod[] = ["DAILY", "WEEKLY", "MONTHLY"];

async function getOrCreateSupportActivitySettings() {
  return prisma.supportActivitySettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
}

export async function setSupportActivityEnabled(enabled: boolean): Promise<void> {
  await requireAccess("support_activity.manage");
  await getOrCreateSupportActivitySettings();
  await prisma.supportActivitySettings.update({ where: { id: "global" }, data: { enabled } });
  revalidatePath(await projectPath("/support-activity"));
  revalidatePath(await projectPath("/support-activity/settings"));
  revalidatePath(await projectPath("/team-report"));
  revalidatePath(await projectPath("/overview"));
}

export async function updateSupportActivitySettings(formData: FormData): Promise<void> {
  await requireAccess("support_activity.manage");
  const enabled = formData.get("enabled") === "on";
  // Clamped rather than rejected: this is a tuning number, and bouncing the whole form over it
  // would discard the other fields somebody had just set.
  const rawOffline = Number(formData.get("offlineAfterMinutes"));
  const offlineAfterMinutes = Number.isFinite(rawOffline)
    ? Math.min(1440, Math.max(5, Math.round(rawOffline)))
    : 120;

  // Same clamping, same reason. 1 minute to 24 hours: below a minute nearly every reply would count
  // as missed, above a day "missed" stops meaning anything a lead could act on.
  const rawMissed = Number(formData.get("missedReplyAfterMinutes"));
  const missedReplyAfterMinutes = Number.isFinite(rawMissed)
    ? Math.min(1440, Math.max(1, Math.round(rawMissed)))
    : 30;

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
      missedReplyAfterMinutes,
      countingPeriod: countingPeriod as SupportActivityCountingPeriod,
    },
  });
  revalidatePath(await projectPath("/support-activity"));
  revalidatePath(await projectPath("/support-activity/team"));
  revalidatePath(await projectPath("/support-activity/settings"));
  revalidatePath(await projectPath("/overview"));
}
