import type { MediaCleanupJob, Prisma } from "@prisma/client";
import type { MediaStorage } from "@support-automation/media-storage";
import { mediaRetentionCutoff } from "@support-automation/shared";
import { trackTick } from "../lifecycle.js";
import { platformPrisma, prisma } from "../db.js";
import { forEachProject, OPERATING_PROJECT_STATUSES, withProject } from "../project/context.js";
import { recordLoopTick, registerLoop } from "../health/loopLiveness.js";
import { logSystemEvent } from "../logging/logSystemEvent.js";
import { getMediaStorageSettings } from "./registerMessageMedia.js";

/**
 * Removes stored media files older than a date, in the background and in batches
 * (MEDIA_STORAGE.md). Two sources of jobs, one way of running them:
 *
 *   MANUAL     an admin's "Delete media older than…" on Settings (the web only writes the job row).
 *   RETENTION  the project's retention setting; scheduled here at most every few hours.
 *
 * What it touches: the FILE, and the media row's status (→ DELETED). Never a `Message` row — the
 * text of every message stays, and the chat shows "removed by retention" where the file was.
 *
 * Order: the file is deleted first, then the row marked. A file that cannot be deleted keeps its
 * row STORED (counted as failed, the reason recorded), so nothing claims a deletion that did not
 * happen, and the next run tries it again. A crash between the two leaves a STORED row whose file
 * is already gone; deleting a missing file succeeds, so the retry converges.
 *
 * Restart-safe: the job's keyset cursor is saved after every batch.
 */

const LOOP_NAME = "media-cleanup";

/** Rows per batch: one indexed range read and one update each, so no batch holds a lock for long. */
export const MEDIA_CLEANUP_BATCH_SIZE = 200;
/** A retention job is created at most this often per project. */
export const RETENTION_RESCHEDULE_MS = 6 * 60 * 60_000;
const RETENTION_SCHEDULE_CHECK_MS = 10 * 60_000;

export const ACTIVE_CLEANUP_STATUSES = ["SCHEDULED", "RUNNING"] as const;

/**
 * For every operating project with a retention period: creates a RETENTION job when one is due and
 * there is something to remove. A project set to "keep everything" has its scheduled retention jobs
 * cancelled instead — retention switched off must stop deleting at once.
 */
export async function scheduleRetentionCleanups(now: Date = new Date()): Promise<void> {
  await forEachProject("media-retention", async () => {
    const { retentionDays } = await getMediaStorageSettings();
    const active = await prisma.mediaCleanupJob.findFirst({ where: { status: { in: [...ACTIVE_CLEANUP_STATUSES] } } });
    if (retentionDays === null) {
      if (active?.trigger === "RETENTION") await cancelJob(active.id, "Retention was changed to keep everything.");
      return;
    }
    if (active) return; // one job at a time per project
    const recent = await prisma.mediaCleanupJob.findFirst({
      where: { trigger: "RETENTION", createdAt: { gt: new Date(now.getTime() - RETENTION_RESCHEDULE_MS) } },
      select: { id: true },
    });
    if (recent) return;
    const olderThan = mediaRetentionCutoff(now, retentionDays);
    const anything = await prisma.messageMedia.findFirst({ where: { status: "STORED", createdAt: { lt: olderThan } }, select: { id: true } });
    if (!anything) return;
    await prisma.mediaCleanupJob.create({ data: { trigger: "RETENTION", olderThan, retentionDays, createdAt: now } });
  });
}

async function cancelJob(id: string, reason: string): Promise<void> {
  await prisma.mediaCleanupJob.update({ where: { id }, data: { status: "CANCELLED", lastError: reason, completedAt: new Date() } });
}

function candidateWhere(job: MediaCleanupJob): Prisma.MessageMediaWhereInput {
  const where: Prisma.MessageMediaWhereInput = { status: "STORED", createdAt: { lt: job.olderThan } };
  if (job.cursorCreatedAt && job.cursorId) {
    where.OR = [{ createdAt: { gt: job.cursorCreatedAt } }, { createdAt: job.cursorCreatedAt, id: { gt: job.cursorId } }];
  }
  return where;
}

/** Runs one batch of one job inside its project. Exported for the tests. */
export async function runCleanupBatch(jobId: string, storage: MediaStorage | null, batchSize = MEDIA_CLEANUP_BATCH_SIZE): Promise<void> {
  let job = await prisma.mediaCleanupJob.findUnique({ where: { id: jobId } });
  if (!job || !(ACTIVE_CLEANUP_STATUSES as readonly string[]).includes(job.status)) return;

  if (!storage) {
    await prisma.mediaCleanupJob.update({
      where: { id: job.id },
      data: { status: "FAILED", lastError: "Media storage is not configured on the worker (MEDIA_STORAGE_DIR), so nothing was removed.", completedAt: new Date() },
    });
    return;
  }

  if (job.trigger === "RETENTION") {
    // A retention job removes what the setting said when it was made. If the setting has changed
    // since — longer, shorter or off — it stops rather than deleting by a rule nobody holds now.
    const { retentionDays } = await getMediaStorageSettings();
    if (retentionDays !== job.retentionDays) {
      await cancelJob(job.id, "The retention setting changed, so this cleanup stopped. A new one follows the new setting.");
      return;
    }
  }

  if (job.status === "SCHEDULED") {
    const totalCandidates = await prisma.messageMedia.count({ where: { status: "STORED", createdAt: { lt: job.olderThan } } });
    job = await prisma.mediaCleanupJob.update({
      where: { id: job.id },
      data: { status: "RUNNING", startedAt: new Date(), totalCandidates },
    });
  }

  const rows = await prisma.messageMedia.findMany({
    where: candidateWhere(job),
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: batchSize,
    select: { id: true, storageKey: true, thumbnailKey: true, sizeBytes: true, createdAt: true },
  });

  const removed: string[] = [];
  let freed = 0n;
  let failed = 0;
  let lastError: string | null = null;
  for (const row of rows) {
    try {
      if (row.storageKey) await storage.delete(row.storageKey);
      if (row.thumbnailKey) await storage.delete(row.thumbnailKey);
      removed.push(row.id);
      freed += row.sizeBytes ?? 0n;
    } catch (err) {
      failed += 1;
      lastError = `A file could not be removed and was kept: ${(err as Error).message}`.slice(0, 500);
    }
  }
  if (removed.length) {
    await prisma.messageMedia.updateMany({
      where: { id: { in: removed }, status: "STORED" },
      data: { status: "DELETED", statusReason: job.trigger === "RETENTION" ? "RETENTION" : "MANUAL_CLEANUP", deletedAt: new Date() },
    });
  }

  const last = rows.at(-1);
  const done = rows.length < batchSize;
  const failedTotal = job.failedCount + failed;
  await prisma.mediaCleanupJob.update({
    where: { id: job.id },
    data: {
      processedCount: { increment: rows.length },
      deletedCount: { increment: removed.length },
      failedCount: { increment: failed },
      freedBytes: { increment: freed },
      ...(last ? { cursorCreatedAt: last.createdAt, cursorId: last.id } : {}),
      ...(lastError ? { lastError } : {}),
      ...(done
        ? {
            status: "COMPLETED",
            completedAt: new Date(),
            ...(failedTotal > 0
              ? { lastError: `${failedTotal} file(s) could not be removed and were kept. The next cleanup will try them again.` }
              : {}),
          }
        : {}),
    },
  });
  if (done) {
    const final = await prisma.mediaCleanupJob.findUnique({ where: { id: job.id } });
    await logSystemEvent(
      failedTotal > 0 ? "WARN" : "INFO",
      "media",
      `Media cleanup finished: ${final?.deletedCount ?? 0} file(s) removed${failedTotal ? `, ${failedTotal} kept after an error` : ""}`,
      { trigger: job.trigger, olderThan: job.olderThan.toISOString(), freedBytes: String(final?.freedBytes ?? 0) },
      { targetType: "MediaCleanupJob", targetId: job.id },
    );
  }
}

/** One batch of the oldest active job, across projects. Returns whether there was a job. */
export async function processOneCleanupBatch(storage: MediaStorage | null): Promise<boolean> {
  const job = await platformPrisma.mediaCleanupJob.findFirst({
    where: { status: { in: [...ACTIVE_CLEANUP_STATUSES] }, project: { status: { in: [...OPERATING_PROJECT_STATUSES] } } },
    orderBy: { createdAt: "asc" },
    select: { id: true, projectId: true },
  });
  if (!job) return false;
  await withProject(job.projectId, () => runCleanupBatch(job.id, storage));
  return true;
}

export function startMediaCleanupProcessor(storage: MediaStorage | null, intervalMs = 5000): NodeJS.Timeout {
  registerLoop(LOOP_NAME, intervalMs);
  let running = false;
  let lastScheduled = 0;
  return setInterval(() => {
    if (running) return;
    running = true;
    void trackTick(async () => {
      try {
        if (Date.now() - lastScheduled >= RETENTION_SCHEDULE_CHECK_MS) {
          lastScheduled = Date.now();
          await scheduleRetentionCleanups();
        }
        await processOneCleanupBatch(storage);
      } catch (err) {
        console.error("[media-cleanup] tick failed", err);
      } finally {
        running = false;
        recordLoopTick(LOOP_NAME, intervalMs);
      }
    });
  }, intervalMs);
}
