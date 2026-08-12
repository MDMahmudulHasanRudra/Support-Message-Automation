import { prisma } from "@support-automation/db";
import type { GroupParticipantAddItem } from "@prisma/client";
import type { WhatsAppProvider } from "../provider/WhatsAppProvider.js";
import { getAutomationSettings } from "../pipeline/settings.js";
import {
  countJobAddedLastMinute,
  markJobStartedIfNeeded,
  markJobStoppedByKillSwitch,
  maybeCompleteParticipantAddJob,
} from "./groupParticipantAddQueue.js";

const STUCK_PROCESSING_TIMEOUT_MS = 2 * 60_000;
/** How long to defer an item when its job's own per-minute cap is hit — not a failure, just a wait. */
const JOB_RATE_LIMIT_DEFER_MS = 15_000;
/** Fixed backoff before a retried add attempt — this job type has no retryIntervalsMs list like AutomationSettings. */
const RETRY_DELAY_MS = 60_000;

/** Crash recovery: items left in PROCESSING by a worker that died mid-add go back to PENDING. */
export async function recoverStuckParticipantAddItems(): Promise<number> {
  const cutoff = new Date(Date.now() - STUCK_PROCESSING_TIMEOUT_MS);
  const result = await prisma.groupParticipantAddItem.updateMany({
    where: { status: "PROCESSING", updatedAt: { lt: cutoff } },
    data: { status: "PENDING" },
  });
  return result.count;
}

/** Atomically claims exactly one due PENDING item, or null if none are ready. */
async function claimNextItem() {
  const candidate = await prisma.groupParticipantAddItem.findFirst({
    where: { status: "PENDING", scheduledAt: { lte: new Date() } },
    orderBy: { scheduledAt: "asc" },
  });
  if (!candidate) return null;

  const claim = await prisma.groupParticipantAddItem.updateMany({
    where: { id: candidate.id, status: "PENDING" },
    data: { status: "PROCESSING" },
  });
  if (claim.count === 0) return null; // lost the race (shouldn't happen with a single worker, but defensive)

  return prisma.groupParticipantAddItem.findUniqueOrThrow({ where: { id: candidate.id } });
}

/**
 * Pre-add gate: the job may have been stopped (by a user or the kill
 * switch) after this item was scheduled, or its own per-minute cap may
 * already be exhausted by other items added since this one was queued.
 */
async function handlePreAddChecks(item: GroupParticipantAddItem): Promise<"STOP_TICK" | "CONTINUE"> {
  const job = await prisma.groupParticipantAddJob.findUnique({
    where: { id: item.jobId },
    select: { status: true, maxPerMinute: true },
  });

  if (!job || job.status === "CANCELLED" || job.status === "STOPPED_KILL_SWITCH") {
    await prisma.groupParticipantAddItem.update({
      where: { id: item.id },
      data: { status: "CANCELLED", failureReason: "The job was stopped before this group could be processed." },
    });
    await maybeCompleteParticipantAddJob(item.jobId);
    return "STOP_TICK";
  }

  const addedLastMinute = await countJobAddedLastMinute(item.jobId);
  if (addedLastMinute >= job.maxPerMinute) {
    // Defer, not a failure: claimNextItem() already flipped this row to PROCESSING — release it
    // back to PENDING, otherwise it would sit unreclaimed until the stuck-PROCESSING crash-recovery timeout.
    await prisma.groupParticipantAddItem.update({
      where: { id: item.id },
      data: { status: "PENDING", scheduledAt: new Date(Date.now() + JOB_RATE_LIMIT_DEFER_MS) },
    });
    return "STOP_TICK";
  }

  return "CONTINUE";
}

/** Exported for direct testing — drains exactly one due item, or returns false if none are ready. */
export async function processOne(provider: WhatsAppProvider): Promise<boolean> {
  const item = await claimNextItem();
  if (!item) return false;

  const settings = await getAutomationSettings();
  if (!settings.automationEnabled) {
    await prisma.groupParticipantAddItem.update({
      where: { id: item.id },
      data: { status: "CANCELLED", failureReason: "Automation was paused before this group could be processed." },
    });
    await markJobStoppedByKillSwitch(item.jobId);
    await maybeCompleteParticipantAddJob(item.jobId);
    return true;
  }

  const gate = await handlePreAddChecks(item);
  if (gate === "STOP_TICK") return true;

  await markJobStartedIfNeeded(item.jobId);

  const group = await prisma.whatsAppGroup.findUnique({ where: { id: item.groupId } });
  if (!group) {
    await prisma.groupParticipantAddItem.update({
      where: { id: item.id },
      data: { status: "FAILED", attemptCount: { increment: 1 }, failureReason: "Group no longer found.", processedAt: new Date() },
    });
    await maybeCompleteParticipantAddJob(item.jobId);
    return true;
  }

  // Never act blindly: a live, single-chat check right before adding, not just reliance on the
  // (possibly stale) synchronized WhatsAppGroup table used at job-creation time.
  const isMember = await provider.verifyGroupMembership(group.whatsappGroupId);
  if (!isMember) {
    await prisma.groupParticipantAddItem.update({
      where: { id: item.id },
      data: { status: "FAILED", attemptCount: { increment: 1 }, failureReason: "Membership could not be verified.", processedAt: new Date() },
    });
    await maybeCompleteParticipantAddJob(item.jobId);
    return true;
  }

  const job = await prisma.groupParticipantAddJob.findUniqueOrThrow({ where: { id: item.jobId } });

  try {
    const result = await provider.addGroupParticipant(group.whatsappGroupId, job.phoneNumber);
    if (result.success) {
      await prisma.groupParticipantAddItem.update({
        where: { id: item.id },
        data: { status: "ADDED", attemptCount: { increment: 1 }, processedAt: new Date(), failureReason: null },
      });
      await maybeCompleteParticipantAddJob(item.jobId);
    } else {
      await handleAddFailure(item, job.retryMaxAttempts, result.error ?? "Unknown provider error");
    }
  } catch (err) {
    await handleAddFailure(item, job.retryMaxAttempts, (err as Error).message);
  }
  return true;
}

async function handleAddFailure(
  item: GroupParticipantAddItem,
  retryMaxAttempts: number,
  failureReason: string,
): Promise<void> {
  const attemptCount = item.attemptCount + 1;
  if (attemptCount >= retryMaxAttempts) {
    await prisma.groupParticipantAddItem.update({
      where: { id: item.id },
      data: { status: "FAILED", attemptCount, failureReason, processedAt: new Date() },
    });
    await maybeCompleteParticipantAddJob(item.jobId);
    return;
  }
  await prisma.groupParticipantAddItem.update({
    where: { id: item.id },
    data: { status: "PENDING", attemptCount, failureReason, scheduledAt: new Date(Date.now() + RETRY_DELAY_MS) },
  });
}

/**
 * Starts the periodic drain loop. Processes at most one item per tick —
 * same overlap-guarded setInterval pattern as startOutboundQueueProcessor
 * (ENGINEERING_STANDARDS.md §9/§15 "no concurrent duplicate workers").
 */
export function startGroupParticipantAddProcessor(
  provider: WhatsAppProvider,
  intervalMs = 2000,
): NodeJS.Timeout {
  let processing = false;
  return setInterval(() => {
    if (processing) return;
    processing = true;
    processOne(provider)
      .catch((err) => {
        console.error("[queue] unexpected error processing group-participant-add item", err);
      })
      .finally(() => {
        processing = false;
      });
  }, intervalMs);
}
