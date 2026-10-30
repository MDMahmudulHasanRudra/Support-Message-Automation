import { Readable } from "node:stream";
import { NextResponse, type NextRequest } from "next/server";
import { MediaObjectNotFoundError } from "@support-automation/media-storage";
import { globalPrisma } from "@/server/db";
import { getMediaStorage } from "@/server/mediaStorage";
import { verifyAssetSignature } from "@/server/social/media";

/**
 * A Social Studio file for a PLATFORM to fetch while publishing (SOCIAL_STUDIO.md §Media): Meta's
 * publishing API takes media by public URL. No session — the address itself is the permission: a
 * signature over the file id and an expiry at most two hours ahead (`signedAssetUrl`). An unsigned,
 * expired, altered or deleted request is a 404, indistinguishable from a file that never existed.
 * Only the photo and video types the library accepted are ever served, with nosniff and a sandbox.
 */
export const dynamic = "force-dynamic";

const notFound = () => new NextResponse("Not found", { status: 404, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });

export async function GET(request: NextRequest, { params }: { params: Promise<{ assetId: string }> }) {
  const { assetId } = await params;
  if (!/^[a-z0-9]{10,40}$/.test(assetId)) return notFound();
  if (!verifyAssetSignature(assetId, request.nextUrl.searchParams.get("exp"), request.nextUrl.searchParams.get("sig"))) return notFound();
  const asset = await globalPrisma.socialMediaAsset.findUnique({ where: { id: assetId }, select: { storageKey: true, mimeType: true, deletedAt: true } });
  if (!asset || asset.deletedAt || !/^(image\/(jpeg|png|gif|webp)|video\/(mp4|quicktime))$/.test(asset.mimeType)) return notFound();
  const storage = getMediaStorage();
  if (!storage) return notFound();
  try {
    const { stream, size } = await storage.get(asset.storageKey);
    return new NextResponse(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      status: 200,
      headers: {
        "Content-Type": asset.mimeType,
        "Content-Length": String(size),
        "Cache-Control": "private, max-age=600",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch (err) {
    if (err instanceof MediaObjectNotFoundError) return notFound();
    console.error("[social] could not read a media file", (err as Error).name);
    return new NextResponse("Try again", { status: 500 });
  }
}
