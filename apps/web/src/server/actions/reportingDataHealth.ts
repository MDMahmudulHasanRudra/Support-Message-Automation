"use server";

import { revalidatePath } from "next/cache";
import { DHAKA_OFFSET_MS, formatDhakaMoment } from "@support-automation/shared";
import { prisma } from "@/server/db";
import { checkPermission } from "@/server/authorize";
import { projectPath } from "@/server/projectPaths";
import { logSystemEvent } from "@/server/logSystemEvent";

/**
 * The project's "verified reporting from" moment (SUPPORT_INTELLIGENCE_IMPLEMENTATION_AUDIT.md §H).
 * Before it every report labels its figures historical / unverified. Setting it is a statement by an
 * admin that collection has been recorded and trustworthy since then, so it is logged.
 */

export interface VerifiedFromState {
  error?: string;
  saved?: string;
}

/** "2026-10-04T14:30" typed in Asia/Dhaka → the instant. Null for anything that is not that shape. */
function parseDhakaDateTime(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number) as [number, number, number, number, number, number];
  const ms = Date.UTC(y, mo - 1, d, h, mi) - DHAKA_OFFSET_MS;
  const check = new Date(ms + DHAKA_OFFSET_MS);
  // Rejects 31 Feb and friends rather than rolling them into March.
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return new Date(ms);
}

export async function saveReportingVerifiedFrom(_prev: VerifiedFromState, formData: FormData): Promise<VerifiedFromState> {
  const granted = await checkPermission("support_activity.manage", "SUPPORT_ACTIVITY");
  if ("denied" in granted) return { error: granted.denied };

  const clear = formData.get("intent") === "clear";
  let value: Date | null = null;
  if (!clear) {
    value = parseDhakaDateTime(String(formData.get("verifiedFrom") ?? ""));
    if (!value) return { error: "Enter a date and time (Asia/Dhaka), for example 2026-10-04 09:00." };
    if (value.getTime() > Date.now()) return { error: "The verified-from moment cannot be in the future: it states that reporting has been trustworthy since then." };
  }

  await prisma.supportActivitySettings.upsert({
    where: { id: "global" },
    update: { reportingVerifiedFrom: value },
    create: { id: "global", reportingVerifiedFrom: value },
  });
  await logSystemEvent(
    "INFO",
    "reports",
    value ? `Reporting verified from ${formatDhakaMoment(value.getTime())} (Asia/Dhaka)` : "Reporting verified-from date cleared",
    { reportingVerifiedFrom: value?.toISOString() ?? null },
    { actorUserId: granted.session.userId, targetType: "SupportActivitySettings", targetId: "global" },
  );
  revalidatePath(await projectPath("/support-activity/settings"));
  return { saved: value ? `Reporting is verified from ${formatDhakaMoment(value.getTime())}.` : "Cleared: every report is historical / unverified until a date is set." };
}
