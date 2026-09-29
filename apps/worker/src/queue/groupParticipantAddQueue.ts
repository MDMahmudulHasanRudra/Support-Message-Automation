import { prisma } from "../db.js";

const MINUTE_MS = 60_000;

/** Guarantees the singleton settings row exists, defaulting to conservative values (see schema.prisma). */
export async function getGroupParticipantAddSettings() {
  // Read first, upsert only when genuinely absent — the pattern pipeline/settings.ts already uses
  // and explains. An unconditional upsert takes a ROW LOCK and writes a tuple even when nothing
  // changes, and this is read from a polling loop: at rest, with every optional feature off, the
  // eight loops that opened this way were between them issuing roughly two hundred thousand
  // writes a day against a handful of single-row tables, before a single message arrived.
  const existing = await prisma.groupParticipantAddSettings.findUnique({ where: { id: "global" } });
  if (existing) return existing;
  return prisma.groupParticipantAddSettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" },
  });
}

/**
 * Adds attempted in the last minute across EVERY job, independent of (and in addition to) the
 * account-wide AutomationSettings rate limits.
 *
 * Was scoped to one job, which made the per-job size cap actively harmful rather than protective:
 * moving 2,000 groups meant splitting into twenty jobs, nothing stopped those running at once, and
 * twenty jobs at three per minute is sixty per minute on the single operation WhatsApp punishes
 * hardest. A global count is what the setting always claimed to be.
 *
 * Counts SKIPPED_ALREADY_MEMBER too. Establishing that somebody is already in a group is itself a
 * call to WhatsApp, so it costs the same budget as an add — pacing only the successful writes
 * would let a large re-run hammer the API at full speed while reporting that it barely did
 * anything.
 */
export async function countAddedLastMinute(): Promise<number> {
  return prisma.groupParticipantAddItem.count({
    where: {
      status: { in: ["ADDED", "SKIPPED_ALREADY_MEMBER"] },
      processedAt: { gte: new Date(Date.now() - MINUTE_MS) },
    },
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
