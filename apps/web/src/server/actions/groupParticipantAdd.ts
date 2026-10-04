"use server";

import { projectPath } from "@/server/projectPaths";
import { prisma } from "@/server/db";
import { revalidatePath } from "next/cache";

import type { Prisma } from "@prisma/client";
import { normalizePhoneNumber, randomDelayMs } from "@support-automation/shared";
import { requireAccess } from "@/server/authorize";
import { logSystemEvent } from "@/server/logSystemEvent";

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
  /**
   * Set when some of these adds already belong to a job that has not finished: nothing new was
   * created, and this is the job to show instead ("View current process").
   */
  existingJobId?: string;
}

/** Jobs still doing, or about to do, something. */
const ACTIVE_JOB_STATUSES = ["CHECKING", "AWAITING_REVIEW", "QUEUED", "RUNNING"] as const;
/** Pairs not settled yet: still to check, offered for review, or still to add. */
const OPEN_ITEM_STATUSES = ["PENDING_CHECK", "CHECKING", "READY", "CANNOT_VERIFY", "PENDING", "PROCESSING"] as const;

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
  // Enforced on the server, not by hiding a button: this queues real WhatsApp operations against
  // the number that also serves every customer. requireAccess adds the project steps (access,
  // read-only project, the Bulk Messaging entitlement) in front of the same permission check.
  const session = await requireAccess("bulk_messaging.manage");

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

  // The same (number, group) pair must never be in two unfinished jobs at once: both would check it,
  // both would find it missing, and the second add would be refused by WhatsApp — an add attempt
  // spent for nothing on the operation it punishes hardest. Decided under a per-account lock, so two
  // quick clicks or two tabs cannot both pass; the second is shown the first job instead.
  const outcome = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`group-participant-add:${input.accountId}`})::bigint)`;
      const clash = await tx.groupParticipantAddItem.findFirst({
        where: {
          job: { accountId: input.accountId, status: { in: [...ACTIVE_JOB_STATUSES] } },
          status: { in: [...OPEN_ITEM_STATUSES] },
          phoneNumber: { in: phoneNumbers },
          groupId: { in: toQueue.map((t) => t.groupId) },
        },
        select: { jobId: true },
      });
      if (clash) return { existingJobId: clash.jobId };

      const job = await tx.groupParticipantAddJob.create({
        data: {
          accountId: input.accountId,
          createdById: session.userId,
          phoneNumbers,
          totalRequested: dedupedTargets.length * phoneNumbers.length,
          // Nothing is queued to SEND yet. The job starts by reading rosters; `queuedCount` is written
          // at confirm time, once a person has chosen what to add.
          queuedCount: 0,
          preQueueSkipped: preQueueSkipReasons.length,
          preQueueSkipReasons: preQueueSkipReasons as unknown as Prisma.InputJsonValue,
          status: "CHECKING",
          delayMinMs: settings.delayMinMs,
          delayMaxMs: settings.delayMaxMs,
          maxPerMinute: settings.maxPerMinute,
          maxPerJob: settings.maxPerJob,
          retryMaxAttempts: settings.retryMaxAttempts,
        },
        select: { id: true, projectId: true },
      });

      // Every pair starts as something to CHECK, not something to send. The pacing delays are applied
      // later, at confirm — until a person has chosen, there is nothing to pace.
      //
      // createMany in chunks — a 2,000-row job issuing 2,000 separate inserts kept a server action
      // open long enough to look hung, and the wizard cannot report progress until it returns.
      const rows: Prisma.GroupParticipantAddItemCreateManyInput[] = [];
      for (const phone of phoneNumbers) {
        for (const target of toQueue) {
          rows.push({
            projectId: job.projectId,
            jobId: job.id,
            groupId: target.groupId,
            groupNameSnapshot: target.groupName,
            phoneNumber: phone,
            status: "PENDING_CHECK",
          });
        }
      }
      const CHUNK = 500;
      for (let i = 0; i < rows.length; i += CHUNK) {
        await tx.groupParticipantAddItem.createMany({ data: rows.slice(i, i + CHUNK) });
      }
      return { job };
    },
    { timeout: 60_000 },
  );

  if ("existingJobId" in outcome) {
    return {
      existingJobId: outcome.existingJobId,
      error: "Some of these numbers are already being added to some of these groups by a job that has not finished, so nothing new was started.",
    };
  }
  const { job } = outcome;

  await logSystemEvent(
    "INFO",
    "group-participant-add",
    `Membership check started for ${phoneNumbers.length} number(s) across ${toQueue.length} group(s)`,
    { jobId: job.id, accountId: input.accountId, numbers: phoneNumbers.length, groups: toQueue.length },
    { actorUserId: session.userId, targetType: "GroupParticipantAddJob", targetId: job.id },
  );

  revalidatePath(await projectPath("/group-member-adder"));
  return { jobId: job.id };
}

/** Statuses a person may legitimately choose to add. Everything else is a settled "no". */
const SELECTABLE_STATUSES = ["READY", "CANNOT_VERIFY"] as const;

export interface ConfirmParticipantAddResult {
  queued: number;
  /** Selected but no longer eligible — re-checked, or already actioned in another tab. */
  skipped: number;
  error?: string;
}

/**
 * Turns a reviewed selection into queued work.
 *
 * This is the only path from a checked job to an actual WhatsApp add, and the eligibility filter
 * lives in the WHERE rather than in the caller's list: a stale page could otherwise submit an id
 * that has since come back ALREADY_MEMBER and spend exactly the operation the check phase exists
 * to prevent.
 *
 * Unselected eligible rows become NOT_SELECTED rather than being deleted, so the job stays a
 * complete record of what was considered as well as what was done.
 */
export async function confirmParticipantAddSelection(
  jobId: string,
  itemIds: string[],
): Promise<ConfirmParticipantAddResult> {
  const session = await requireAccess("bulk_messaging.manage");

  const job = await prisma.groupParticipantAddJob.findUnique({ where: { id: jobId } });
  if (!job) return { queued: 0, skipped: 0, error: "That job no longer exists." };
  if (job.status !== "AWAITING_REVIEW") {
    return { queued: 0, skipped: 0, error: "This job is no longer waiting for review." };
  }

  const unique = Array.from(new Set(itemIds.map((id) => id.trim()).filter(Boolean)));
  if (unique.length === 0) return { queued: 0, skipped: 0, error: "Select at least one entry to add." };

  const eligible = await prisma.groupParticipantAddItem.findMany({
    where: { id: { in: unique }, jobId, status: { in: [...SELECTABLE_STATUSES] } },
    select: { id: true },
    // Same ordering intent as before: one person lands everywhere before the next begins, so a job
    // stopped halfway leaves whole people done rather than everybody half-added.
    orderBy: [{ phoneNumber: "asc" }, { groupNameSnapshot: "asc" }],
  });

  if (eligible.length > job.maxPerJob) {
    return {
      queued: 0,
      skipped: 0,
      error: `That is ${eligible.length.toLocaleString()} adds, over the limit of ${job.maxPerJob.toLocaleString()} per job. Select fewer.`,
    };
  }

  // The pacing is applied here rather than at creation, because until now nobody knew how many
  // adds there would be. Cumulative, so the queue drains at the configured rate rather than all
  // at once — the throttle that keeps the account safe.
  let cumulativeDelayMs = 0;
  for (const item of eligible) {
    cumulativeDelayMs += randomDelayMs(job.delayMinMs, job.delayMaxMs);
    await prisma.groupParticipantAddItem.update({
      where: { id: item.id },
      data: { status: "PENDING", scheduledAt: new Date(Date.now() + cumulativeDelayMs) },
    });
  }

  // Everything eligible that was NOT chosen. Recorded, not removed.
  await prisma.groupParticipantAddItem.updateMany({
    where: { jobId, status: { in: [...SELECTABLE_STATUSES] }, id: { notIn: eligible.map((i) => i.id) } },
    data: { status: "NOT_SELECTED" },
  });

  await prisma.groupParticipantAddJob.update({
    where: { id: jobId },
    data: { status: "QUEUED", queuedCount: eligible.length },
  });

  await logSystemEvent(
    "INFO",
    "group-participant-add",
    `${eligible.length} participant add(s) approved and queued`,
    { jobId, queued: eligible.length, requested: unique.length },
    { actorUserId: session.userId, targetType: "GroupParticipantAddJob", targetId: jobId },
  );

  revalidatePath(await projectPath(`/group-member-adder/jobs/${jobId}`));
  return { queued: eligible.length, skipped: unique.length - eligible.length };
}

/**
 * Sends pairs back through the membership check.
 *
 * The only honest way to retry. A failed add may have failed because the person joined in the
 * meantime, so re-attempting blind would spend an operation to be told 409 — which is the exact
 * round trip this whole phase exists to avoid. Re-checking first turns that into a skip with no
 * WhatsApp call at all.
 */
export async function recheckParticipantAddItems(jobId: string): Promise<{ rechecked: number; error?: string }> {
  const session = await requireAccess("bulk_messaging.manage");

  const job = await prisma.groupParticipantAddJob.findUnique({ where: { id: jobId } });
  if (!job) return { rechecked: 0, error: "That job no longer exists." };

  // Everything that did not end in an add: failures, unverifiable answers, and checks that never
  // completed. ADDED and SKIPPED_ALREADY_MEMBER are settled history and are left alone.
  const { count } = await prisma.groupParticipantAddItem.updateMany({
    where: {
      jobId,
      status: { in: ["FAILED", "CHECK_FAILED", "CANNOT_VERIFY", "NOT_SELECTED", "NO_PERMISSION", "GROUP_UNAVAILABLE"] },
    },
    data: { status: "PENDING_CHECK", attemptCount: 0, failureReason: null, failureCode: null },
  });
  if (count === 0) return { rechecked: 0, error: "Nothing here needs re-checking." };

  await prisma.groupParticipantAddJob.update({
    where: { id: jobId },
    data: { status: "CHECKING", completedAt: null },
  });

  await logSystemEvent(
    "INFO",
    "group-participant-add",
    `${count} participant pair(s) sent back for re-checking`,
    { jobId, count },
    { actorUserId: session.userId, targetType: "GroupParticipantAddJob", targetId: jobId },
  );

  revalidatePath(await projectPath(`/group-member-adder/jobs/${jobId}`));
  return { rechecked: count };
}

/** Cancels a job's still-PENDING items (an in-flight PROCESSING add is left to finish naturally). */
export async function cancelParticipantAddJob(jobId: string): Promise<void> {
  await requireAccess("bulk_messaging.manage");
  await prisma.groupParticipantAddItem.updateMany({
    where: { jobId, status: "PENDING" },
    data: { status: "CANCELLED", failureReason: "Cancelled by user." },
  });
  await prisma.groupParticipantAddJob.updateMany({
    where: { id: jobId, status: { notIn: ["CANCELLED", "STOPPED_KILL_SWITCH", "COMPLETED"] } },
    data: { status: "CANCELLED", cancelledAt: new Date() },
  });
  revalidatePath(await projectPath(`/group-member-adder/jobs/${jobId}`));
}

/**
 * Retries only FAILED items of this job, resetting their retry budget —
 * ADDED items are never touched. Refuses to resume a job the user or the
 * kill switch explicitly stopped, same defense-in-depth as
 * retryFailedBroadcastMessages.
 */
export async function retryFailedParticipantAddItems(jobId: string): Promise<void> {
  await requireAccess("bulk_messaging.manage");
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

  revalidatePath(await projectPath(`/group-member-adder/jobs/${jobId}`));
}

function dedupeByGroupId(targets: ParticipantAddTargetInput[]): ParticipantAddTargetInput[] {
  const seen = new Map<string, ParticipantAddTargetInput>();
  for (const target of targets) {
    if (!seen.has(target.groupId)) seen.set(target.groupId, target);
  }
  return [...seen.values()];
}
