"use server";

import { projectPath } from "@/server/projectPaths";
import { prisma } from "@/server/db";
import { revalidatePath } from "next/cache";

import { checkPermission, requireAccess } from "@/server/authorize";

export async function retryNotification(id: string): Promise<void> {
  await requireAccess("settings.edit");
  await prisma.notification.update({
    where: { id },
    data: { status: "PENDING", failureReason: null },
  });
  revalidatePath(await projectPath("/notifications"));
}

export interface BulkRetryResult {
  requeued: number;
  /** Selected but no longer FAILED — already retried from another tab, or picked up meanwhile. */
  notFailed: number;
  error?: string;
}

/**
 * Requeues every failed notification matching the current filter.
 *
 * A Teams webhook rotating, or the WhatsApp session dropping for ten minutes, fails every alert
 * raised in that window at once — which is exactly when the delivery log fills with dozens of
 * FAILED rows and the only remedy was a click per row. The rows share one cause and one fix, so
 * they should share one action.
 *
 * Bounded by `status: "FAILED"` in the WHERE rather than by the caller's list, so a stale page
 * cannot resurrect a row that has since been sent — the dispatcher would then deliver it twice.
 */
export async function bulkRetryFailedNotifications(ids: string[]): Promise<BulkRetryResult> {
  const granted = await checkPermission("settings.edit");
  if ("denied" in granted) return { requeued: 0, notFailed: 0, error: granted.denied };

  const unique = Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
  if (unique.length === 0) return { requeued: 0, notFailed: 0, error: "Select at least one notification first." };

  const existing = await prisma.notification.findMany({
    where: { id: { in: unique } },
    select: { id: true, status: true },
  });

  const { count } = await prisma.notification.updateMany({
    where: { id: { in: unique }, status: "FAILED" },
    // Cleared alongside the status: a stale reason beside a PENDING row reads as a fresh failure.
    data: { status: "PENDING", failureReason: null },
  });

  revalidatePath(await projectPath("/notifications"));
  return { requeued: count, notFailed: existing.length - count };
}

/**
 * Requeues every FAILED notification there is, not just the page on screen.
 *
 * Expressed as a status predicate rather than a list of ids on purpose: the rows are failures of
 * one outage, they can number in the hundreds, and shipping every id to the browser and back to
 * describe "all of them" would be a large payload for a set the database can name in a word. It
 * also cannot go stale — anything the dispatcher has since picked up no longer matches.
 */
export async function retryAllFailedNotifications(): Promise<BulkRetryResult> {
  const granted = await checkPermission("settings.edit");
  if ("denied" in granted) return { requeued: 0, notFailed: 0, error: granted.denied };
  const { count } = await prisma.notification.updateMany({
    where: { status: "FAILED" },
    data: { status: "PENDING", failureReason: null },
  });
  revalidatePath(await projectPath("/notifications"));
  return { requeued: count, notFailed: 0 };
}

export interface TestNotificationState {
  error?: string;
  success?: boolean;
}

export async function sendTestNotification(_prevState: TestNotificationState, formData: FormData): Promise<TestNotificationState> {
  const granted = await checkPermission("settings.edit");
  if ("denied" in granted) return { error: granted.denied };
  const settings = await prisma.automationSettings.findUnique({ where: { id: "global" } });
  if (!settings?.teamsWebhookUrl) {
    return { error: "Configure a Teams webhook URL in Settings first." };
  }

  await prisma.notification.create({
    data: {
      type: "TEAMS",
      destination: settings.teamsWebhookUrl,
      payload: {
        message: String(formData.get("message") ?? "This is a test notification from the dashboard."),
        matchedRuleName: "(manual test)",
      },
    },
  });
  revalidatePath(await projectPath("/notifications"));
  return { success: true };
}
