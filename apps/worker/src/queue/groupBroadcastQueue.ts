import { prisma } from "@support-automation/db";

const MINUTE_MS = 60_000;

/** Guarantees the singleton settings row exists, defaulting to conservative values (see schema.prisma). */
export async function getGroupBroadcastSettings() {
  return prisma.groupBroadcastSettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" },
  });
}

/** True once a job has been explicitly stopped (by a user or the kill switch) — remaining PENDING rows must not send. */
export async function isJobStopped(jobId: string): Promise<boolean> {
  const job = await prisma.groupBroadcastJob.findUnique({
    where: { id: jobId },
    select: { status: true },
  });
  return job?.status === "CANCELLED" || job?.status === "STOPPED_KILL_SWITCH";
}

/** Job-scoped throttle, independent of (and in addition to) the account-wide AutomationSettings rate limits. */
export async function countJobSentLastMinute(jobId: string): Promise<number> {
  return prisma.outboundMessage.count({
    where: { broadcastJobId: jobId, status: "SENT", sentAt: { gte: new Date(Date.now() - MINUTE_MS) } },
  });
}

/** Idempotent: only the first caller to observe "job wasn't already stopped" actually flips it. */
export async function markJobStoppedByKillSwitch(jobId: string): Promise<void> {
  await prisma.groupBroadcastJob.updateMany({
    where: { id: jobId, status: { notIn: ["CANCELLED", "STOPPED_KILL_SWITCH"] } },
    data: { status: "STOPPED_KILL_SWITCH", cancelledAt: new Date() },
  });
}

/**
 * Transitions QUEUED/RUNNING -> COMPLETED once no row of the job is still
 * PENDING/PROCESSING — cheap to call after every row settles. Never
 * overwrites CANCELLED/STOPPED_KILL_SWITCH: those are sticky, user- or
 * safety-driven terminal states, not "ran out of work".
 */
export async function maybeCompleteBroadcastJob(jobId: string): Promise<void> {
  const job = await prisma.groupBroadcastJob.findUnique({ where: { id: jobId }, select: { status: true, completedAt: true } });
  if (!job || job.completedAt || job.status === "CANCELLED" || job.status === "STOPPED_KILL_SWITCH") return;

  const stillActive = await prisma.outboundMessage.count({
    where: { broadcastJobId: jobId, status: { in: ["PENDING", "PROCESSING"] } },
  });
  if (stillActive === 0) {
    await prisma.groupBroadcastJob.update({ where: { id: jobId }, data: { status: "COMPLETED", completedAt: new Date() } });
  }
}

/** First row of a job to actually reach PROCESSING flips it out of QUEUED, purely for a nicer "started at" timestamp. */
export async function markJobStartedIfNeeded(jobId: string): Promise<void> {
  await prisma.groupBroadcastJob.updateMany({
    where: { id: jobId, startedAt: null },
    data: { startedAt: new Date(), status: "RUNNING" },
  });
}
