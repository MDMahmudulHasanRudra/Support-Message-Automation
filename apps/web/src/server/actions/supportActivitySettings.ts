"use server";

import { projectPath } from "@/server/projectPaths";
import { prisma } from "@/server/db";
import { revalidatePath } from "next/cache";

import type { SupportActivityCountingPeriod } from "@prisma/client";
import { requireAccess } from "@/server/authorize";
import { clampFallbackMinutes } from "@support-automation/shared";

const VALID_PERIODS: SupportActivityCountingPeriod[] = ["DAILY", "WEEKLY", "MONTHLY"];

async function getOrCreateSupportActivitySettings() {
  return prisma.supportActivitySettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
}

export async function setSupportActivityEnabled(enabled: boolean): Promise<void> {
  await requireAccess("support_activity.manage", "SUPPORT_ACTIVITY");
  await getOrCreateSupportActivitySettings();
  await prisma.supportActivitySettings.update({ where: { id: "global" }, data: { enabled } });
  revalidatePath(await projectPath("/support-activity"));
  revalidatePath(await projectPath("/support-activity/settings"));
  revalidatePath(await projectPath("/team-report"));
  revalidatePath(await projectPath("/overview"));
}

export async function updateSupportActivitySettings(formData: FormData): Promise<void> {
  await requireAccess("support_activity.manage", "SUPPORT_ACTIVITY");
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

  // Support Overtime's default duty length (TEAM_OVERTIME.md), typed in HOURS and stored in minutes —
  // converted once, here. Absent from the form (an older tab) or unparseable: left as it is, never
  // silently reset. Clamped to 1–16 hours by the shared rule the report also applies when reading.
  const rawFallbackHours = formData.get("overtimeFallbackDutyHours");
  const parsedFallbackHours = rawFallbackHours === null || String(rawFallbackHours).trim() === "" ? Number.NaN : Number(rawFallbackHours);
  const overtimeFallbackDutyMinutes = Number.isFinite(parsedFallbackHours) ? clampFallbackMinutes(parsedFallbackHours * 60) : undefined;

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
      ...(overtimeFallbackDutyMinutes !== undefined ? { overtimeFallbackDutyMinutes } : {}),
      countingPeriod: countingPeriod as SupportActivityCountingPeriod,
    },
  });
  revalidatePath(await projectPath("/support-activity"));
  revalidatePath(await projectPath("/support-activity/team"));
  revalidatePath(await projectPath("/support-activity/settings"));
  revalidatePath(await projectPath("/overview"));
  revalidatePath(await projectPath("/team-report"));
}
