import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { sniffSocialMedia, socialMediaLimit, type SocialMediaKind } from "@support-automation/shared";
import { prisma } from "@/server/db";
import { activeProjectId } from "@/server/projectContext";
import { getMediaStorage } from "@/server/mediaStorage";
import { publicOrigin } from "@/server/google/oauth";

/**
 * The Social Studio media library (SOCIAL_STUDIO.md §Media). Files live on the media volume through the
 * existing `MediaStorage` (MEDIA_STORAGE.md), under `social/<projectId>/<random>.<ext>`:
 *   - the type is read from the FIRST BYTES (JPEG, PNG, WebP, GIF, MP4, MOV), never from the name;
 *   - per-file limits (8 MB photo, 200 MB video), a per-project allowance (SOCIAL_MEDIA_PROJECT_MB,
 *     5 GB by default), and nothing is written when the disk is nearly full (MEDIA_MIN_FREE_DISK_MB);
 *   - agents see files through the project's own checked route; a PLATFORM fetches a file only through a
 *     short-lived signed address (`signedAssetUrl`), which is what Meta's publishing API requires.
 * Deleting marks the row and removes the file; posts keep their history.
 */

export class SocialMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SocialMediaError";
  }
}

function allowanceBytes(): number {
  const mb = Number(process.env.SOCIAL_MEDIA_PROJECT_MB ?? 5120);
  return (Number.isFinite(mb) && mb > 0 ? mb : 5120) * 1024 * 1024;
}

function minFreeBytes(): number {
  const mb = Number(process.env.MEDIA_MIN_FREE_DISK_MB ?? 2048);
  return (Number.isFinite(mb) && mb >= 0 ? mb : 2048) * 1024 * 1024;
}

function cleanName(name: string, extension: string): string {
  const base = name.replace(/[\u0000-\u001f\u007f"\\/<>|:*?]/g, "").trim().slice(0, 120);
  const stem = base.replace(/\.[A-Za-z0-9]{1,5}$/, "") || "file";
  return `${stem}.${extension}`;
}

export function cleanFolder(raw: unknown): string | null {
  const v = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ").slice(0, 60) : "";
  return v || null;
}

export function cleanTags(raw: unknown): string[] {
  const list = typeof raw === "string" ? raw.split(",") : Array.isArray(raw) ? raw : [];
  return [...new Set(list.map((t) => String(t).trim().toLowerCase().replace(/^#/, "").slice(0, 40)).filter(Boolean))].slice(0, 20);
}

export async function mediaUsage(): Promise<{ usedBytes: number; allowanceBytes: number; files: number }> {
  const agg = await prisma.socialMediaAsset.aggregate({ where: { deletedAt: null }, _sum: { sizeBytes: true }, _count: { _all: true } });
  return { usedBytes: agg._sum.sizeBytes ?? 0, allowanceBytes: allowanceBytes(), files: agg._count._all };
}

export async function uploadSocialAsset(input: { bytes: Buffer; fileName: string; folder: string | null; username: string }) {
  if (input.bytes.length === 0) throw new SocialMediaError("The file is empty.");
  const kind = sniffSocialMedia(new Uint8Array(input.bytes.subarray(0, 32)));
  if (!kind) throw new SocialMediaError("Only JPEG, PNG, WebP or GIF photos and MP4 or MOV videos can be uploaded.");
  const limit = socialMediaLimit(kind.kind);
  if (input.bytes.length > limit) throw new SocialMediaError(`${kind.kind === "VIDEO" ? "Videos" : "Photos"} can be at most ${Math.round(limit / 1024 / 1024)} MB.`);
  const usage = await mediaUsage();
  if (usage.usedBytes + input.bytes.length > usage.allowanceBytes) throw new SocialMediaError("This project's media library is full. Delete files you no longer need, or ask an administrator for more space.");
  const storage = getMediaStorage();
  if (!storage) throw new SocialMediaError("Media storage is not set up on this server (MEDIA_STORAGE_DIR).");
  const free = await storage.freeBytes().catch(() => null);
  if (free !== null && free - input.bytes.length < minFreeBytes()) throw new SocialMediaError("The server's storage is nearly full, so the file was not saved. Ask your administrator to free some space.");

  const projectId = await activeProjectId();
  const storageKey = `social/${projectId}/${randomBytes(16).toString("hex")}.${kind.extension}`;
  await storage.put(storageKey, input.bytes, { maxBytes: limit });
  try {
    return await prisma.socialMediaAsset.create({
      data: {
        storageKey,
        name: cleanName(input.fileName, kind.extension),
        kind: kind.kind,
        mimeType: kind.mimeType,
        sizeBytes: input.bytes.length,
        folder: input.folder,
        uploadedByUsername: input.username,
      },
      select: { id: true, name: true, kind: true, mimeType: true, sizeBytes: true },
    });
  } catch (err) {
    await storage.delete(storageKey).catch(() => undefined);
    throw err;
  }
}

export interface SocialAssetView {
  id: string;
  name: string;
  kind: SocialMediaKind;
  mimeType: string;
  sizeBytes: number;
  folder: string | null;
  tags: string[];
  altText: string | null;
  uploadedByUsername: string;
  createdAt: string;
  usedInPosts: number;
}

export async function listSocialAssets(filter: { q?: string; folder?: string; kind?: string; take?: number } = {}): Promise<SocialAssetView[]> {
  const q = filter.q?.trim();
  const rows = await prisma.socialMediaAsset.findMany({
    where: {
      deletedAt: null,
      ...(filter.folder ? { folder: filter.folder } : {}),
      ...(filter.kind === "IMAGE" || filter.kind === "VIDEO" ? { kind: filter.kind } : {}),
      ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { tags: { has: q.toLowerCase().replace(/^#/, "") } }, { altText: { contains: q, mode: "insensitive" } }] } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(filter.take ?? 200, 1000),
  });
  const counts = new Map<string, number>();
  if (rows.length) {
    const posts = await prisma.socialPost.findMany({ where: { mediaIds: { hasSome: rows.map((r) => r.id) } }, select: { mediaIds: true } });
    for (const p of posts) for (const id of p.mediaIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind === "VIDEO" ? "VIDEO" : "IMAGE",
    mimeType: r.mimeType,
    sizeBytes: r.sizeBytes,
    folder: r.folder,
    tags: r.tags,
    altText: r.altText,
    uploadedByUsername: r.uploadedByUsername,
    createdAt: r.createdAt.toISOString(),
    usedInPosts: counts.get(r.id) ?? 0,
  }));
}

export async function listAssetFolders(): Promise<string[]> {
  const rows = await prisma.socialMediaAsset.findMany({ where: { deletedAt: null, folder: { not: null } }, distinct: ["folder"], select: { folder: true }, orderBy: { folder: "asc" }, take: 200 });
  return rows.map((r) => r.folder!).filter(Boolean);
}

export async function updateSocialAsset(id: string, input: { name?: string; folder?: string | null; tags?: string[]; altText?: string | null }) {
  const updated = await prisma.socialMediaAsset.updateMany({
    where: { id, deletedAt: null },
    data: {
      ...(input.name !== undefined ? { name: input.name.trim().slice(0, 120) || "file" } : {}),
      ...(input.folder !== undefined ? { folder: input.folder } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.altText !== undefined ? { altText: input.altText?.trim().slice(0, 500) || null } : {}),
    },
  });
  if (updated.count === 0) throw new SocialMediaError("That file no longer exists.");
}

/** Deletes a file no waiting post still needs. Published history keeps its record without the file. */
export async function deleteSocialAsset(id: string): Promise<void> {
  const asset = await prisma.socialMediaAsset.findFirst({ where: { id, deletedAt: null }, select: { id: true, storageKey: true } });
  if (!asset) throw new SocialMediaError("That file no longer exists.");
  const waiting = await prisma.socialPost.count({ where: { mediaIds: { has: id }, status: { in: ["DRAFT", "IN_REVIEW", "APPROVED", "SCHEDULED", "UNKNOWN"] } } });
  if (waiting > 0) throw new SocialMediaError(`${waiting} post(s) that are not published yet use this file. Remove it from them first.`);
  await prisma.socialMediaAsset.update({ where: { id: asset.id }, data: { deletedAt: new Date() } });
  await getMediaStorage()?.delete(asset.storageKey).catch(() => undefined);
}

// ── Signed addresses for platforms ──────────────────────────────────────────────────────────────

const SIGNED_TTL_MS = 2 * 60 * 60_000;

function signingKey(): Buffer | null {
  const own = process.env.SOCIAL_MEDIA_URL_SECRET?.trim();
  if (own && own.length >= 32) return Buffer.from(own);
  const base = process.env.NEXTAUTH_SECRET?.trim() || process.env.AUTH_SECRET?.trim();
  return base ? createHmac("sha256", base).update("social-media-url-v1").digest() : null;
}

function signature(key: Buffer, assetId: string, exp: number): string {
  return createHmac("sha256", key).update(`${assetId}.${exp}`).digest("base64url");
}

/**
 * An https address a platform can fetch the file from for two hours, or a sentence saying why there is
 * none. Meta fetches publishing media from a public URL; this one names the file and its expiry only.
 */
export function signedAssetUrl(assetId: string, now = new Date()): { ok: true; url: string } | { ok: false; reason: string } {
  const origin = publicOrigin();
  if (!origin || !origin.startsWith("https://")) return { ok: false, reason: "This server's public address (NEXTAUTH_URL) must be https and reachable from the internet for platforms to fetch media." };
  const key = signingKey();
  if (!key) return { ok: false, reason: "No signing secret is configured (SOCIAL_MEDIA_URL_SECRET or NEXTAUTH_SECRET)." };
  const exp = Math.floor((now.getTime() + SIGNED_TTL_MS) / 1000);
  return { ok: true, url: `${origin}/api/social/media/${encodeURIComponent(assetId)}?exp=${exp}&sig=${signature(key, assetId, exp)}` };
}

export function verifyAssetSignature(assetId: string, exp: string | null, sig: string | null, now = new Date()): boolean {
  const key = signingKey();
  if (!key || !exp || !sig || !/^\d{9,12}$/.test(exp)) return false;
  const expiry = Number(exp);
  if (expiry * 1000 < now.getTime() || expiry * 1000 > now.getTime() + SIGNED_TTL_MS + 60_000) return false;
  const expected = Buffer.from(signature(key, assetId, expiry));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
