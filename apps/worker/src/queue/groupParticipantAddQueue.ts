import { prisma } from "@support-automation/db";

const MINUTE_MS = 60_000;

/** Guarantees the singleton settings row exists, defaulting to conservative values (see schema.prisma). */
export async function getGroupParticipantAddSettings() {
  return prisma.groupParticipantAddSettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" },
  });
}

/** Job-scoped throttle, independent of (and in addition to) the account-wide AutomationSettings rate limits. */
export async function countJobAddedLastMinute(jobId: string): Promise<number> {
  return prisma.groupParticipantAddItem.count({
    where: { jobId, status: "ADDED", processedAt: { gte: new Date(Date.now() - MINUTE_MS) } },
  });
}

/** Idempotent: only the first caller to observe "job wasn't already stopped" actually flips it. */
export async function markJobStoppedByKillSwitch(jobId: string): Promise<void> {
  await prisma.groupParticipantAddJob.updateMany({
    where: { id: jobId, status: { notIn: ["CANCELLED", "STOPPED_KILL_SWITCH"] } },
    data: { status: "STOPPED_KILL_SWITCH", cancelledAt: new Date() },
  });
}

/**
 * Transitions QUEUED/RUNNING -> COMPLETED once no item of the job is still
 * PENDING/PROCESSING — cheap to call after every item settles. Never
 * overwrites CANCELLED/STOPPED_KILL_SWITCH: those are sticky, user- or
 * safety-driven terminal states, not "ran out of work".
 */
export async function maybeCompleteParticipantAddJob(jobId: string): Promise<void> {
  const job = await prisma.groupParticipantAddJob.findUnique({
    where: { id: jobId },
    select: { status: true, completedAt: true },
  });
  if (!job || job.completedAt || job.status === "CANCELLED" || job.status === "STOPPED_KILL_SWITCH") return;

  const stillActive = await prisma.groupParticipantAddItem.count({
    where: { jobId, status: { in: ["PENDING", "PROCESSING"] } },
  });
  if (stillActive === 0) {
    await prisma.groupParticipantAddJob.update({
      where: { id: jobId },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
  }
}

/** First item of a job to actually reach PROCESSING flips it out of QUEUED, purely for a nicer "started at" timestamp. */
export async function markJobStartedIfNeeded(jobId: string): Promise<void> {
  await prisma.groupParticipantAddJob.updateMany({
    where: { id: jobId, startedAt: null },
    data: { startedAt: new Date(), status: "RUNNING" },
  });
}
