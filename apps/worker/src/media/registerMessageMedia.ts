import type { Prisma } from "@prisma/client";
import {
  DEFAULT_MEDIA_STORAGE_SWITCHES,
  decideMediaRegistration,
  type MediaStorageSwitches,
} from "@support-automation/shared";
import { prisma } from "../db.js";
import type { RawMediaDescriptor } from "../pipeline/types.js";

/**
 * This project's media switches and retention. An absent row means the defaults — every type
 * stored, kept indefinitely — and is never written here: a read on every media message must not
 * become a write.
 */
export async function getMediaStorageSettings(): Promise<{ switches: MediaStorageSwitches; retentionDays: number | null }> {
  const row = await prisma.mediaStorageSettings.findUnique({ where: { id: "global" } });
  if (!row) return { switches: { ...DEFAULT_MEDIA_STORAGE_SWITCHES }, retentionDays: null };
  return {
    switches: {
      storeImages: row.storeImages,
      storeVideos: row.storeVideos,
      storeAudio: row.storeAudio,
      storeDocuments: row.storeDocuments,
      storeStickers: row.storeStickers,
      storeGifs: row.storeGifs,
      storeOther: row.storeOther,
    },
    retentionDays: row.retentionDays,
  };
}

/**
 * Records the attachment of a message that has JUST been stored, and queues its file for the media
 * worker. Called by the pipeline right after the `Message` insert — and only after it, so the
 * message exists whatever happens here.
 *
 * Nothing is downloaded on this path: it is one settings read and one insert. The file is fetched
 * later by `mediaDownloadProcessor`, so a 200 MB video cannot hold up the message behind it.
 *
 * Never throws. A failure here is logged and the message carries on through the pipeline
 * untouched: a message must never depend on its attachment.
 *
 * Idempotent: `MessageMedia.messageId` is unique, so a redelivered event cannot add a second row —
 * and the pipeline only reaches here for a message it has just inserted, which a redelivery is not.
 */
export async function registerMessageMedia(input: {
  messageId: string;
  accountId: string;
  groupId: string | null;
  media: RawMediaDescriptor;
}): Promise<void> {
  try {
    const { switches } = await getMediaStorageSettings();
    const decision = decideMediaRegistration({
      type: input.media.mediaType,
      switches,
      declaredSizeBytes: input.media.declaredSizeBytes,
    });
    await prisma.messageMedia.create({
      data: {
        messageId: input.messageId,
        accountId: input.accountId,
        groupId: input.groupId,
        mediaType: input.media.mediaType,
        waType: input.media.waType,
        mimeType: input.media.mimeType,
        fileName: input.media.fileName,
        declaredSizeBytes: input.media.declaredSizeBytes === null ? null : BigInt(input.media.declaredSizeBytes),
        width: input.media.width,
        height: input.media.height,
        durationSeconds: input.media.durationSeconds,
        isAnimated: input.media.isAnimated,
        status: decision.status,
        statusReason: decision.status === "NOT_STORED" ? decision.reason : null,
        // Only a file that will be fetched keeps what it takes to fetch it.
        download: decision.status === "PENDING" && input.media.download ? (input.media.download as unknown as Prisma.InputJsonValue) : undefined,
        // From this process's clock, never the database default: the download loop compares it
        // against this process's clock (see CLAUDE.md on scheduledAt fixtures).
        nextAttemptAt: new Date(),
      },
    });
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") return; // already recorded
    console.error(`[media] could not record the attachment of message ${input.messageId}; the message itself is stored`, err);
  }
}
