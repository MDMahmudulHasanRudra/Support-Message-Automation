import {
  DEFAULT_MEDIA_STORAGE_SWITCHES,
  MESSAGE_MEDIA_TYPES,
  type MediaStorageSwitches,
  type MessageMediaKind,
  type MessageMediaState,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { getMediaStorage } from "@/server/mediaStorage";

/**
 * Read side of Settings → Message & Media Storage (MEDIA_STORAGE.md). Every figure here comes from
 * the `MessageMedia` rows — the size recorded when each file was written — never an estimate and
 * never a scan of the disk.
 */

export interface MediaStorageSettingsView extends MediaStorageSwitches {
  retentionDays: number | null;
  updatedAt: Date | null;
}

/** This project's settings, or the defaults when no row exists. A read: rendering never writes. */
export async function getMediaStorageSettingsView(): Promise<MediaStorageSettingsView> {
  const row = await prisma.mediaStorageSettings.findUnique({ where: { id: "global" } });
  if (!row) return { ...DEFAULT_MEDIA_STORAGE_SWITCHES, retentionDays: null, updatedAt: null };
  return {
    storeImages: row.storeImages,
    storeVideos: row.storeVideos,
    storeAudio: row.storeAudio,
    storeDocuments: row.storeDocuments,
    storeStickers: row.storeStickers,
    storeGifs: row.storeGifs,
    storeOther: row.storeOther,
    retentionDays: row.retentionDays,
    updatedAt: row.updatedAt,
  };
}

export interface MediaUsage {
  totalBytes: number;
  totalFiles: number;
  byType: Array<{ type: MessageMediaKind; files: number; bytes: number }>;
  /** Attachments in every state, so "stored" is never read as "every attachment". */
  byStatus: Record<MessageMediaState, number>;
}

/**
 * What is stored, by type. Two grouped counts over the project's media rows, on the
 * `(projectId, status, mediaType)` index — the cost grows with the number of files, not with the
 * number of messages, and nothing here touches the disk.
 */
export async function getMediaUsage(): Promise<MediaUsage> {
  const [stored, statuses] = await Promise.all([
    prisma.messageMedia.groupBy({ by: ["mediaType"], where: { status: "STORED" }, _count: { _all: true }, _sum: { sizeBytes: true } }),
    prisma.messageMedia.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);
  const byType = MESSAGE_MEDIA_TYPES.map((type) => {
    const row = stored.find((r) => r.mediaType === type);
    return { type, files: row?._count._all ?? 0, bytes: Number(row?._sum.sizeBytes ?? 0) };
  });
  const byStatus = { PENDING: 0, DOWNLOADING: 0, STORED: 0, NOT_STORED: 0, FAILED: 0, DELETED: 0 } as Record<MessageMediaState, number>;
  for (const row of statuses) byStatus[row.status] = row._count._all;
  return {
    totalBytes: byType.reduce((sum, t) => sum + t.bytes, 0),
    totalFiles: byType.reduce((sum, t) => sum + t.files, 0),
    byType,
    byStatus,
  };
}

/** What a cleanup with this cutoff would remove right now: stored files and their recorded sizes. */
export async function previewMediaCleanupCandidates(olderThan: Date): Promise<{ files: number; bytes: number }> {
  const result = await prisma.messageMedia.aggregate({
    where: { status: "STORED", createdAt: { lt: olderThan } },
    _count: { _all: true },
    _sum: { sizeBytes: true },
  });
  return { files: result._count._all, bytes: Number(result._sum.sizeBytes ?? 0) };
}

export interface MediaCleanupJobView {
  id: string;
  trigger: "MANUAL" | "RETENTION";
  status: "SCHEDULED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  olderThan: Date;
  totalCandidates: number | null;
  processedCount: number;
  deletedCount: number;
  failedCount: number;
  freedBytes: number;
  lastError: string | null;
  requestedBy: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export async function getMediaCleanupJobs(limit = 8): Promise<MediaCleanupJobView[]> {
  const rows = await prisma.mediaCleanupJob.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { requestedBy: { select: { name: true, username: true } } },
  });
  return rows.map((row) => ({
    id: row.id,
    trigger: row.trigger,
    status: row.status,
    olderThan: row.olderThan,
    totalCandidates: row.totalCandidates,
    processedCount: row.processedCount,
    deletedCount: row.deletedCount,
    failedCount: row.failedCount,
    freedBytes: Number(row.freedBytes),
    lastError: row.lastError,
    requestedBy: row.requestedBy ? row.requestedBy.name || row.requestedBy.username : null,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  }));
}

/** Whether the dashboard can reach media storage, and how much room is left on it. */
export async function getMediaStorageHealth(): Promise<{ configured: boolean; driver: string | null; freeBytes: number | null }> {
  const storage = getMediaStorage();
  if (!storage) return { configured: false, driver: null, freeBytes: null };
  return { configured: true, driver: storage.driver, freeBytes: await storage.freeBytes() };
}
