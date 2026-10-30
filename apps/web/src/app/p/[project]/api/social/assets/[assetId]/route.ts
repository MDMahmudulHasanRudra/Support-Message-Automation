import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { MediaObjectNotFoundError } from "@support-automation/media-storage";
import { prisma } from "@/server/db";
import { getSession } from "@/server/auth";
import { checkPermission } from "@/server/authorize";
import { getMediaStorage } from "@/server/mediaStorage";

/**
 * A media library file for the project's own people (SOCIAL_STUDIO.md §Media): session, `social.view`
 * with Social Studio on, and the row read through the PROJECT-SCOPED client (another project's id is a
 * 404). Photos and videos only, inline, with nosniff and a sandbox.
 */
export const dynamic = "force-dynamic";

const refuse = (status: number, message: string) => NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });

export async function GET(_request: Request, { params }: { params: Promise<{ assetId: string }> }) {
  if (!(await getSession())) return refuse(401, "Sign in to view this file.");
  const access = await checkPermission("social.view", "SOCIAL_STUDIO");
  if ("denied" in access) return refuse(403, access.denied);
  const { assetId } = await params;
  const asset = await prisma.socialMediaAsset.findFirst({ where: { id: assetId, deletedAt: null }, select: { storageKey: true, mimeType: true, name: true } });
  if (!asset) return refuse(404, "This file is not available.");
  const storage = getMediaStorage();
  if (!storage) return refuse(503, "Media storage is not configured on this server.");
  try {
    const { stream, size } = await storage.get(asset.storageKey);
    return new NextResponse(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      status: 200,
      headers: {
        "Content-Type": asset.mimeType,
        "Content-Length": String(size),
        "Content-Disposition": `inline; filename="${asset.name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "")}"`,
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; img-src 'self'; media-src 'self'; sandbox",
        "Cross-Origin-Resource-Policy": "same-origin",
      },
    });
  } catch (err) {
    if (err instanceof MediaObjectNotFoundError) return refuse(404, "This file is no longer in media storage.");
    return refuse(500, "The file could not be read.");
  }
}
