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
  /** One or more numbers. The work queued is every number against every group. */
  phoneNumbers: string[];
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

  // Normalize first, then dedupe on the normalized form: "+8801700000000" and "8801700000000" are
  // one person, and queueing both would add them once and then report a failure for the second.
  const phoneNumbers: string[] = [];
  const invalid: string[] = [];
  for (const raw of input.phoneNumbers) {
    const normalized = normalizePhoneNumber(raw);
    if (!normalized) {
      if (raw.trim()) invalid.push(raw.trim());
      continue;
    }
    if (!phoneNumbers.includes(normalized)) phoneNumbers.push(normalized);
  }
  if (invalid.length > 0) {
    return {
      error: `Not a valid number (digits and country code only): ${invalid.slice(0, 3).join(", ")}${
        invalid.length > 3 ? ` and ${invalid.length - 3} more` : ""
      }.`,
    };
  }
  if (phoneNumbers.length === 0) return { error: "Add at least one phone number." };

  const dedupedTargets = dedupeByGroupId(input.targets);
  if (dedupedTargets.length === 0) return { error: "No target groups selected." };

  const settings = await prisma.groupParticipantAddSettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" },
  });

  // The cap counts real work — every number against every group — not group rows. 5 people across
  // 500 groups is 2,500 adds however few groups were ticked, and pacing is what makes that safe.
  const totalAdds = dedupedTargets.length * phoneNumbers.length;
  if (totalAdds > settings.maxPerJob) {
    return {
      error: `That is ${totalAdds.toLocaleString()} adds (${phoneNumbers.length} number${
        phoneNumbers.length === 1 ? "" : "s"
      } × ${dedupedTargets.length.toLocaleString()} groups), over the limit of ${settings.maxPerJob.toLocaleString()} per job. Raise it on Sending Limits, or select fewer.`,
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
      phoneNumbers,
      totalRequested: dedupedTargets.length * phoneNumbers.length,
      queuedCount: toQueue.length * phoneNumbers.length,
      preQueueSkipped: preQueueSkipReasons.length,
      preQueueSkipReasons: preQueueSkipReasons as unknown as Prisma.InputJsonValue,
      delayMinMs: settings.delayMinMs,
      delayMaxMs: settings.delayMaxMs,
      maxPerMinute: settings.maxPerMinute,
      maxPerJob: settings.maxPerJob,
      retryMaxAttempts: settings.retryMaxAttempts,
    },
  });

  // Grouped by number rather than by group: one person lands everywhere before the next begins,
  // so a job stopped halfway leaves whole people done instead of everybody half-added.
  //
  // createMany in chunks — a 2,000-row job issuing 2,000 separate inserts kept a server action
  // open long enough to look hung, and the wizard cannot report progress until it returns.
  let cumulativeDelayMs = 0;
  const rows: Prisma.GroupParticipantAddItemCreateManyInput[] = [];
  for (const phone of phoneNumbers) {
    for (const target of toQueue) {
      cumulativeDelayMs += randomDelayMs(settings.delayMinMs, settings.delayMaxMs);
      rows.push({
        jobId: job.id,
        groupId: target.groupId,
        groupNameSnapshot: target.groupName,
        phoneNumber: phone,
        scheduledAt: new Date(Date.now() + cumulativeDelayMs),
      });
    }
  }
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await prisma.groupParticipantAddItem.createMany({ data: rows.slice(i, i + CHUNK) });
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
