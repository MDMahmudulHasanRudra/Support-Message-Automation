"use server";

import { revalidatePath } from "next/cache";
import { ACTIVE_ADMIN_PROMOTION_JOB_STATUSES, normalizeAdminTargetNumber } from "@support-automation/shared";
import { prisma } from "@/server/db";
import { checkPermission } from "@/server/authorize";
import { projectPath } from "@/server/projectPaths";
import { logSystemEvent } from "@/server/logSystemEvent";

/**
 * WhatsApp Groups Admin Maker — the dashboard's three actions (GROUP_ADMIN_MAKER.md). None of them
 * talks to WhatsApp: they write the job row, and the worker's own loop does the work, so the job
 * survives the page being closed, refreshed or navigated away from. Same key as Add Number to Groups
 * (`bulk_messaging.manage`), which checkPermission also tests against the project's Bulk Messaging
 * entitlement, read-only state and access level.
 */

export interface StartAdminPromotionResult {
  jobId?: string;
  /** True when an identical job was already running and that one is returned instead. */
  existing?: boolean;
  error?: string;
}

const CHUNK = 500;

export async function startGroupAdminPromotion(input: { accountId: string; phoneNumber: string }): Promise<StartAdminPromotionResult> {
  const granted = await checkPermission("bulk_messaging.manage", "BULK_MESSAGING");
  if ("denied" in granted) return { error: granted.denied };

  const phoneNumber = normalizeAdminTargetNumber(input.phoneNumber ?? "");
  if (!phoneNumber) return { error: "Enter one WhatsApp number, with or without the country code (for example +8801XXXXXXXXX or 01XXXXXXXXX)." };

  const account = await prisma.whatsAppAccount.findFirst({ where: { id: input.accountId }, select: { id: true, label: true, status: true } });
  if (!account) return { error: "That WhatsApp account was not found in this project." };
  if (account.status !== "CONNECTED") {
    return { error: `"${account.label}" is not connected. Connect it on WhatsApp Accounts first — the groups can only be checked through a live session.` };
  }

  const groups = await prisma.whatsAppGroup.findMany({
    where: { accountId: account.id, isActive: true },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  if (groups.length === 0) return { error: `"${account.label}" has no synchronized groups. Resync its groups on WhatsApp Groups, then try again.` };

  // One active job per account + number, decided under a lock so two quick clicks (or two tabs)
  // cannot both pass the check: the second gets the first one's job back.
  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`group-admin-promotion:${account.id}:${phoneNumber}`})::bigint)`;
    const active = await tx.groupAdminPromotionJob.findFirst({
      where: { accountId: account.id, phoneNumber, status: { in: [...ACTIVE_ADMIN_PROMOTION_JOB_STATUSES] } },
      select: { id: true },
    });
    if (active) return { jobId: active.id, existing: true };
    const job = await tx.groupAdminPromotionJob.create({
      data: { accountId: account.id, phoneNumber, createdById: granted.session.userId, totalGroups: groups.length },
      select: { id: true, projectId: true },
    });
    for (let i = 0; i < groups.length; i += CHUNK) {
      await tx.groupAdminPromotionItem.createMany({
        data: groups.slice(i, i + CHUNK).map((g) => ({ projectId: job.projectId, jobId: job.id, groupId: g.id, groupNameSnapshot: g.name })),
      });
    }
    return { jobId: job.id, existing: false };
  });

  if (!outcome.existing) {
    await logSystemEvent(
      "INFO",
      "group-admin-promotion",
      `Admin Maker started for ${groups.length} group(s)`,
      { jobId: outcome.jobId, accountId: account.id, groups: groups.length },
      { actorUserId: granted.session.userId, targetType: "GroupAdminPromotionJob", targetId: outcome.jobId },
    );
  }
  revalidatePath(await projectPath("/group-admin-maker"));
  return outcome;
}

export interface AdminPromotionActionResult {
  error?: string;
  success?: string;
}

/** Stops the job. Groups already promoted stay promoted; the rest are left undecided. */
export async function cancelGroupAdminPromotion(jobId: string): Promise<AdminPromotionActionResult> {
  const granted = await checkPermission("bulk_messaging.manage", "BULK_MESSAGING");
  if ("denied" in granted) return { error: granted.denied };
  const result = await prisma.groupAdminPromotionJob.updateMany({
    where: { id: jobId, status: { in: [...ACTIVE_ADMIN_PROMOTION_JOB_STATUSES] } },
    data: { status: "CANCELLED", statusReason: "Cancelled by a person. Groups already promoted stay promoted.", cancelledAt: new Date() },
  });
  if (result.count === 0) return { error: "This job is no longer running." };
  await logSystemEvent("INFO", "group-admin-promotion", "Admin Maker cancelled", { jobId }, { actorUserId: granted.session.userId, targetType: "GroupAdminPromotionJob", targetId: jobId });
  revalidatePath(await projectPath(`/group-admin-maker/jobs/${jobId}`));
  return { success: "Cancelled." };
}

/** Carries on a job paused by a dropped connection or the kill switch, from where it stopped. */
export async function resumeGroupAdminPromotion(jobId: string): Promise<AdminPromotionActionResult> {
  const granted = await checkPermission("bulk_messaging.manage", "BULK_MESSAGING");
  if ("denied" in granted) return { error: granted.denied };
  const job = await prisma.groupAdminPromotionJob.findFirst({
    where: { id: jobId },
    select: { status: true, adminGroups: true, account: { select: { label: true, status: true } } },
  });
  if (!job) return { error: "That job was not found." };
  if (job.status !== "PAUSED_DISCONNECTED" && job.status !== "STOPPED_KILL_SWITCH") return { error: "Only a paused job can be resumed." };
  if (job.account.status !== "CONNECTED") return { error: `"${job.account.label}" is still not connected. Reconnect it on WhatsApp Accounts first.` };
  if (job.status === "STOPPED_KILL_SWITCH") {
    const settings = await prisma.automationSettings.findFirst({ select: { automationEnabled: true } });
    if (settings && !settings.automationEnabled) return { error: "Automation is still turned off. Turn it on in Automation Control first." };
  }
  await prisma.groupAdminPromotionJob.update({
    where: { id: jobId },
    // A job paused before it finished checking goes back to checking; otherwise it carries on.
    data: { status: job.adminGroups === null ? "CHECKING" : "RUNNING", statusReason: null, pausedAt: null },
  });
  revalidatePath(await projectPath(`/group-admin-maker/jobs/${jobId}`));
  return { success: "Resumed." };
}
