"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@support-automation/db";
import type { Prisma } from "@prisma/client";
import { normalizePhoneNumber, randomDelayMs } from "@support-automation/shared";
import { requireSession } from "@/server/auth";

export interface ParticipantAddTargetInput {
  groupId: string;
  groupName: string;
}

export interface CreateParticipantAddJobInput {
  accountId: string;
  phoneNumber: string;
  targets: ParticipantAddTargetInput[];
}

export interface CreateParticipantAddJobResult {
  jobId?: string;
  error?: string;
}

/**
 * Re-derives and re-validates everything server-side, same philosophy as
 * createGroupBroadcastJob: the client's selection is a UI convenience,
 * never trusted as-is (phone number format, per-job size cap, and each
 * group's account ownership are all re-checked here against current DB
 * state).
 */
export async function createGroupParticipantAddJob(
  input: CreateParticipantAddJobInput,
): Promise<CreateParticipantAddJobResult> {
  const session = await requireSession();

  const account = await prisma.whatsAppAccount.findUnique({ where: { id: input.accountId } });
  if (!account) return { error: "WhatsApp account not found." };

  const phoneNumber = normalizePhoneNumber(input.phoneNumber);
  if (!phoneNumber) return { error: "Enter a valid phone number (digits only, with country code)." };

  const dedupedTargets = dedupeByGroupId(input.targets);
  if (dedupedTargets.length === 0) return { error: "No target groups selected." };

  const settings = await prisma.groupParticipantAddSettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" },
  });

  if (dedupedTargets.length > settings.maxPerJob) {
    return {
      error: `This job has ${dedupedTargets.length} groups, exceeding the configured maximum of ${settings.maxPerJob} per job. Split it into smaller jobs.`,
    };
  }

  // Never trust client-supplied group ids/names as-is — re-verify every target still belongs to this account.
  const groupRows = await prisma.whatsAppGroup.findMany({
    where: { accountId: input.accountId, id: { in: dedupedTargets.map((t) => t.groupId) } },
  });
  const groupById = new Map(groupRows.map((g) => [g.id, g]));

  const preQueueSkipReasons: Array<{ groupName: string; reason: string }> = [];
  const toQueue: Array<{ groupId: string; groupName: string }> = [];

  for (const target of dedupedTargets) {
    const group = groupById.get(target.groupId);
    if (!group) {
      preQueueSkipReasons.push({
        groupName: target.groupName,
        reason: "Group no longer found for this account (it may have been removed or resynced away).",
      });
      continue;
    }
    toQueue.push({ groupId: target.groupId, groupName: group.name });
  }

  if (toQueue.length === 0) {
    return { error: "Every target group was skipped before queueing (see reasons shown in preview) — nothing to add." };
  }

  const job = await prisma.groupParticipantAddJob.create({
    data: {
      accountId: input.accountId,
      createdById: session.userId,
      phoneNumber,
      totalRequested: dedupedTargets.length,
      queuedCount: toQueue.length,
      preQueueSkipped: preQueueSkipReasons.length,
      preQueueSkipReasons: preQueueSkipReasons as unknown as Prisma.InputJsonValue,
      delayMinMs: settings.delayMinMs,
      delayMaxMs: settings.delayMaxMs,
      maxPerMinute: settings.maxPerMinute,
      maxPerJob: settings.maxPerJob,
      retryMaxAttempts: settings.retryMaxAttempts,
    },
  });

  let cumulativeDelayMs = 0;
  for (const target of toQueue) {
    cumulativeDelayMs += randomDelayMs(settings.delayMinMs, settings.delayMaxMs);
    await prisma.groupParticipantAddItem.create({
      data: {
        jobId: job.id,
        groupId: target.groupId,
        groupNameSnapshot: target.groupName,
        scheduledAt: new Date(Date.now() + cumulativeDelayMs),
      },
    });
  }

  revalidatePath("/group-member-adder");
  return { jobId: job.id };
}

/** Cancels a job's still-PENDING items (an in-flight PROCESSING add is left to finish naturally). */
export async function cancelParticipantAddJob(jobId: string): Promise<void> {
  await requireSession();
  await prisma.groupParticipantAddItem.updateMany({
    where: { jobId, status: "PENDING" },
    data: { status: "CANCELLED", failureReason: "Cancelled by user." },
  });
  await prisma.groupParticipantAddJob.updateMany({
    where: { id: jobId, status: { notIn: ["CANCELLED", "STOPPED_KILL_SWITCH", "COMPLETED"] } },
    data: { status: "CANCELLED", cancelledAt: new Date() },
  });
  revalidatePath(`/group-member-adder/jobs/${jobId}`);
}

/**
 * Retries only FAILED items of this job, resetting their retry budget —
 * ADDED items are never touched. Refuses to resume a job the user or the
 * kill switch explicitly stopped, same defense-in-depth as
 * retryFailedBroadcastMessages.
 */
export async function retryFailedParticipantAddItems(jobId: string): Promise<void> {
  await requireSession();
  const job = await prisma.groupParticipantAddJob.findUnique({ where: { id: jobId } });
  if (!job || job.status === "CANCELLED" || job.status === "STOPPED_KILL_SWITCH") {
    return;
  }

  const result = await prisma.groupParticipantAddItem.updateMany({
    where: { jobId, status: "FAILED" },
    data: { status: "PENDING", attemptCount: 0, failureReason: null, scheduledAt: new Date() },
  });

  if (result.count > 0 && job.status === "COMPLETED") {
    await prisma.groupParticipantAddJob.update({ where: { id: jobId }, data: { status: "RUNNING", completedAt: null } });
  }

  revalidatePath(`/group-member-adder/jobs/${jobId}`);
}

function dedupeByGroupId(targets: ParticipantAddTargetInput[]): ParticipantAddTargetInput[] {
  const seen = new Map<string, ParticipantAddTargetInput>();
  for (const target of targets) {
    if (!seen.has(target.groupId)) seen.set(target.groupId, target);
  }
  return [...seen.values()];
}
