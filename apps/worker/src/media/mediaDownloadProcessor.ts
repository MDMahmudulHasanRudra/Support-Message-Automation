import { Prisma, type MessageMedia } from "@prisma/client";
import { buildMediaStorageKey, MediaTooLargeError, type MediaStorage } from "@support-automation/media-storage";
import { MEDIA_SIZE_LIMIT_BYTES, MESSAGE_MEDIA_SETTING_FIELD, type MediaStatusReason } from "@support-automation/shared";
import { trackTick } from "../lifecycle.js";
import { platformPrisma, prisma } from "../db.js";
import { withProject } from "../project/context.js";
import { recordLoopTick, registerLoop } from "../health/loopLiveness.js";
import { logSystemEvent } from "../logging/logSystemEvent.js";
import type { MediaDownloadInfo } from "../pipeline/types.js";
import type { WhatsAppProvider } from "../provider/WhatsAppProvider.js";
import { fetchAndStoreWhatsAppMedia, MediaDownloadError, MediaExpiredError, type FetchLike } from "./fetchWhatsAppMedia.js";
import { MediaIntegrityError } from "./whatsappMediaCrypto.js";
import { getMediaStorageSettings } from "./registerMessageMedia.js";

/**
 * The media worker (MEDIA_STORAGE.md): fetches attachments the pipeline recorded as PENDING and
 * writes the original files to media storage. Entirely off the message path — the messages these
 * files belong to were stored, automated and answered before this ever looked at them.
 *
 * A small pool, not one-at-a-time: one large video must not hold every screenshot behind it for
 * minutes. Each download is claimed by flipping its row PENDING → DOWNLOADING (only one claimer
 * can win that update), so nothing is fetched twice, and a crash mid-download leaves a DOWNLOADING
 * row that `recoverStuckMediaDownloads` puts back.
 *
 * Outcomes, all recorded on the row and never on the message:
 *   STORED       the original file is stored, its size and SHA-256 recorded.
 *   NOT_STORED   the type was switched off before the worker got to it, or it is over the limit.
 *   FAILED       WhatsApp no longer has the file (EXPIRED), it never matched WhatsApp's checksum
 *                twice, or every retry failed. The message stays exactly as it was.
 *   PENDING      a failure that may pass, rescheduled with a growing delay.
 */

const LOOP_NAME = "media-download";

/** Anything with `get(accountId)` — the registry in production, a stub in the tests. */
export interface ProviderSource {
  get(accountId: string): WhatsAppProvider | undefined;
}

export interface MediaDownloadDeps {
  storage: MediaStorage | null;
  providers?: ProviderSource;
  fetchImpl?: FetchLike;
  /** Below this much free space nothing new is written; the disk is shared with the database. */
  minFreeBytes?: number;
  now?: () => Date;
}

/** Tries in all, including the first. */
export const MEDIA_DOWNLOAD_MAX_ATTEMPTS = 4;
/** Delay before the 2nd, 3rd and 4th try. */
export const MEDIA_DOWNLOAD_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000] as const;
/** A DOWNLOADING row this old belongs to a download that died with its process. */
export const MEDIA_DOWNLOAD_STUCK_MS = 45 * 60_000;

/** Projects whose media is collected: everywhere messages are still stored (suspended too — a
 *  message is stored there, and WhatsApp's copy of its file will not wait for reactivation). */
const COLLECTING_PROJECT_STATUSES = ["SETUP", "ACTIVE", "SUSPENDED"] as const;

function defaultMinFreeBytes(): number {
  const mb = Number(process.env.MEDIA_MIN_FREE_DISK_MB ?? 2048);
  return (Number.isFinite(mb) && mb >= 0 ? mb : 2048) * 1024 * 1024;
}

/**
 * Claims up to `limit` due downloads, oldest first, across projects. A row is claimed only if this
 * update is the one that moves it out of PENDING.
 */
export async function claimDueMediaDownloads(limit: number, now: Date = new Date()): Promise<Array<{ id: string; projectId: string }>> {
  if (limit <= 0) return [];
  const due = await platformPrisma.messageMedia.findMany({
    where: { status: "PENDING", nextAttemptAt: { lte: now }, project: { status: { in: [...COLLECTING_PROJECT_STATUSES] } } },
    orderBy: { nextAttemptAt: "asc" },
    take: limit,
    select: { id: true, projectId: true },
  });
  const claimed: Array<{ id: string; projectId: string }> = [];
  for (const row of due) {
    const { count } = await platformPrisma.messageMedia.updateMany({
      where: { id: row.id, status: "PENDING" },
      data: { status: "DOWNLOADING", downloadStartedAt: now, attemptCount: { increment: 1 } },
    });
    if (count === 1) claimed.push(row);
  }
  return claimed;
}

async function settle(
  id: string,
  status: "NOT_STORED" | "FAILED",
  reason: MediaStatusReason,
  lastError: string | null,
): Promise<void> {
  // The fetch details are dropped once the row is settled: a settled row needs none of them.
  await prisma.messageMedia.update({ where: { id }, data: { status, statusReason: reason, lastError, download: Prisma.DbNull } });
}

async function retryOrFail(row: MessageMedia, reason: MediaStatusReason, message: string, now: Date): Promise<void> {
  if (row.attemptCount >= MEDIA_DOWNLOAD_MAX_ATTEMPTS) {
    await settle(row.id, "FAILED", reason, message);
    return;
  }
  const delay = MEDIA_DOWNLOAD_RETRY_DELAYS_MS[Math.min(row.attemptCount - 1, MEDIA_DOWNLOAD_RETRY_DELAYS_MS.length - 1)]!;
  await prisma.messageMedia.update({
    where: { id: row.id },
    data: { status: "PENDING", statusReason: reason, lastError: message, nextAttemptAt: new Date(now.getTime() + delay) },
  });
}

/** The fetch details for a row: what the message carried, or — when it carried none — a fresh read from the live session. */
async function downloadInfoFor(row: MessageMedia, providers: ProviderSource | undefined): Promise<MediaDownloadInfo | "NOT_CONNECTED" | null> {
  const stored = row.download as unknown as MediaDownloadInfo | null;
  if (stored?.mediaKey) return stored;
  const provider = providers?.get(row.accountId);
  if (!provider || provider.getConnectionStatus() !== "CONNECTED") return "NOT_CONNECTED";
  const message = await prisma.message.findUnique({ where: { id: row.messageId }, select: { whatsappMessageId: true } });
  if (!message) return null;
  return provider.getMediaDownloadInfo(message.whatsappMessageId);
}

/** Downloads one claimed row inside its own project. Exported for the tests. */
export async function processMediaDownload(id: string, deps: MediaDownloadDeps): Promise<void> {
  const now = deps.now?.() ?? new Date();
  const row = await prisma.messageMedia.findUnique({ where: { id } });
  if (!row || row.status !== "DOWNLOADING") return;

  try {
    // The switch is re-read: an admin who turned a type off between arrival and download meant it.
    const { switches } = await getMediaStorageSettings();
    if (!switches[MESSAGE_MEDIA_SETTING_FIELD[row.mediaType]]) {
      await settle(row.id, "NOT_STORED", "SETTING_OFF", null);
      return;
    }
    const limit = MEDIA_SIZE_LIMIT_BYTES[row.mediaType];
    if (row.declaredSizeBytes !== null && Number(row.declaredSizeBytes) > limit) {
      await settle(row.id, "NOT_STORED", "TOO_LARGE", null);
      return;
    }
    if (!deps.storage) {
      await retryOrFail(row, "STORAGE_UNAVAILABLE", "Media storage is not configured on the worker (MEDIA_STORAGE_DIR).", now);
      return;
    }
    const free = await deps.storage.freeBytes();
    const minFree = deps.minFreeBytes ?? defaultMinFreeBytes();
    if (free !== null && free - Number(row.declaredSizeBytes ?? 0) < minFree) {
      await retryOrFail(row, "DISK_LOW", "The media disk is nearly full, so nothing new is being stored.", now);
      return;
    }

    const info = await downloadInfoFor(row, deps.providers);
    if (info === "NOT_CONNECTED") {
      await retryOrFail(row, "NO_DOWNLOAD_INFO", "WhatsApp did not include the file's details, and the account is not connected to fetch them.", now);
      return;
    }
    if (!info) {
      await settle(row.id, "FAILED", "NO_DOWNLOAD_INFO", "WhatsApp did not provide this file.");
      return;
    }

    const storageKey = buildMediaStorageKey({
      projectId: row.projectId,
      accountId: row.accountId,
      groupId: row.groupId,
      mediaId: row.id,
      createdAt: row.createdAt,
    });
    const file = await fetchAndStoreWhatsAppMedia({
      info,
      waType: row.waType,
      mimeType: row.mimeType,
      declaredSizeBytes: row.declaredSizeBytes === null ? null : Number(row.declaredSizeBytes),
      maxBytes: limit,
      storage: deps.storage,
      storageKey,
      fetchImpl: deps.fetchImpl,
    });

    // WhatsApp's own preview, beside the original. Never instead of it, and never a reason to fail.
    let thumbnailKey: string | null = null;
    const thumbnail = decodeJpeg(info.thumbnailJpegBase64);
    if (thumbnail) {
      const key = buildMediaStorageKey({
        projectId: row.projectId,
        accountId: row.accountId,
        groupId: row.groupId,
        mediaId: row.id,
        createdAt: row.createdAt,
        variant: "thumbnail",
      });
      thumbnailKey = await deps.storage.put(key, thumbnail).then(
        () => key,
        () => null,
      );
    }

    await prisma.messageMedia.update({
      where: { id: row.id },
      data: {
        status: "STORED",
        statusReason: null,
        lastError: null,
        storageKey,
        thumbnailKey,
        sizeBytes: BigInt(file.size),
        sha256: file.sha256Hex,
        storedAt: new Date(),
        download: Prisma.DbNull,
      },
    });
  } catch (err) {
    if (err instanceof MediaTooLargeError) {
      await settle(row.id, "NOT_STORED", "TOO_LARGE", null);
    } else if (err instanceof MediaExpiredError) {
      await settle(row.id, "FAILED", "EXPIRED", err.message);
    } else if (err instanceof MediaIntegrityError) {
      await retryOrFail(row, "INTEGRITY", err.message, now);
    } else if (err instanceof MediaDownloadError) {
      await retryOrFail(row, "DOWNLOAD_FAILED", err.message, now);
    } else {
      const message = (err as Error)?.message ?? String(err);
      await retryOrFail(row, "DOWNLOAD_FAILED", message, now);
      await logSystemEvent("ERROR", "media", "A media download failed unexpectedly", { mediaId: row.id, error: message.slice(0, 300) }, {
        targetType: "MessageMedia",
        targetId: row.id,
      });
    }
  }
}

/** WhatsApp's preview: base64 JPEG, small. Anything else is ignored rather than stored. */
function decodeJpeg(base64: string | null | undefined): Buffer | null {
  if (!base64 || base64.length > 400_000) return null;
  const bytes = Buffer.from(base64, "base64");
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? bytes : null;
}

/**
 * Puts back downloads that died with the process that claimed them. At boot every DOWNLOADING row
 * is stale (nothing can be running yet); afterwards only one older than MEDIA_DOWNLOAD_STUCK_MS.
 */
export async function recoverStuckMediaDownloads(options: { atBoot?: boolean } = {}): Promise<number> {
  const where: Prisma.MessageMediaWhereInput = options.atBoot
    ? { status: "DOWNLOADING" }
    : { status: "DOWNLOADING", downloadStartedAt: { lt: new Date(Date.now() - MEDIA_DOWNLOAD_STUCK_MS) } };
  const { count } = await platformPrisma.messageMedia.updateMany({ where, data: { status: "PENDING", nextAttemptAt: new Date() } });
  return count;
}

/** Concurrent downloads. Two keeps one large video from blocking everything behind it. */
function concurrency(): number {
  const n = Number(process.env.MEDIA_DOWNLOAD_CONCURRENCY ?? 2);
  return Number.isInteger(n) && n >= 1 && n <= 8 ? n : 2;
}

/**
 * The background loop: every tick fills the free download slots. Each download runs on its own and
 * the tick does not wait for it, so the slots stay busy while one long video finishes.
 */
export function startMediaDownloadProcessor(deps: MediaDownloadDeps, intervalMs = 2000): NodeJS.Timeout {
  registerLoop(LOOP_NAME, intervalMs);
  const max = concurrency();
  let inFlight = 0;
  let claiming = false;
  return setInterval(() => {
    if (claiming) return;
    claiming = true;
    void trackTick(async () => {
      try {
        const claimed = await claimDueMediaDownloads(max - inFlight);
        for (const row of claimed) {
          inFlight += 1;
          void trackTick(() => withProject(row.projectId, () => processMediaDownload(row.id, deps)))
            .catch((err) => console.error("[media] download failed", row.id, err))
            .finally(() => {
              inFlight -= 1;
            });
        }
      } catch (err) {
        console.error("[media] claiming downloads failed", err);
      } finally {
        claiming = false;
        recordLoopTick(LOOP_NAME, intervalMs);
      }
    });
  }, intervalMs);
}
