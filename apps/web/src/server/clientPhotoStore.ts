import type { Prisma } from "@prisma/client";
import { CLIENT_PHOTO_LIMITS, prepareClientPhoto } from "@support-automation/shared";
import { recordClientActivity } from "@/server/clientRecords";

/**
 * Storing a client's profile photo (CLIENTS_V3.md §6). Not a "use server" file. The bytes are checked
 * and stripped of metadata by `prepareClientPhoto` (packages/shared) — the type is read from the bytes,
 * the size and dimensions are capped, EXIF/XMP/comments are removed — and only then stored, as a
 * bounded `bytea` in its own table (a CHECK constraint enforces the cap again). Deleting the client
 * deletes the photo with it.
 */

/** The raw upload is refused before it is even read into memory when it is obviously too big. */
const MAX_UPLOAD_BYTES = CLIENT_PHOTO_LIMITS.maxBytes;

export async function saveClientPhoto(
  tx: Prisma.TransactionClient,
  clientId: string,
  file: File,
  actorUserId: string,
): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  if (file.size > MAX_UPLOAD_BYTES) return { ok: false, message: `The picture is larger than ${MAX_UPLOAD_BYTES / 1024} KB. Choose another or let the form resize it.` };
  const prepared = prepareClientPhoto(new Uint8Array(await file.arrayBuffer()));
  if (!prepared.ok) return { ok: false, message: prepared.error };
  const data = { mimeType: prepared.type, bytes: Buffer.from(prepared.bytes), width: prepared.width, height: prepared.height, uploadedById: actorUserId };
  await tx.clientPhoto.upsert({ where: { clientId }, create: { clientId, ...data }, update: data });
  await tx.client.update({ where: { id: clientId }, data: { photoUpdatedAt: new Date() } });
  await recordClientActivity(tx, clientId, actorUserId, { type: "PHOTO_CHANGED", summary: "Profile photo updated" });
  return { ok: true, message: "Photo saved." };
}
