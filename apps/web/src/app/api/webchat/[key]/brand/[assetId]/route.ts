import { Readable } from "node:stream";
import { NextResponse, type NextRequest } from "next/server";
import { MediaObjectNotFoundError } from "@support-automation/media-storage";
import { loadPublicWidget, widgetBrandAsset } from "@/server/channels/webchat";
import { getMediaStorage } from "@/server/mediaStorage";

/**
 * A widget's own brand image (logo, launcher icon, a team photo the admin approved with consent): public by
 * design, because it is part of how the widget looks on the customer's website. Served only while the widget is
 * live and its settings still list the image; removing it there stops this at once. Only the JPEG / PNG / WebP
 * the upload accepted from the bytes, never SVG, with nosniff and a sandbox.
 */
export const dynamic = "force-dynamic";

const notFound = () => new NextResponse("Not found", { status: 404, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });

export async function GET(_request: NextRequest, { params }: { params: Promise<{ key: string; assetId: string }> }) {
  const { key, assetId } = await params;
  if (!/^[A-Za-z0-9_-]{12,40}$/.test(assetId)) return notFound();
  const widget = await loadPublicWidget(key);
  const asset = widget ? widgetBrandAsset(widget, assetId) : null;
  if (!asset) return notFound();
  const storage = getMediaStorage();
  if (!storage) return notFound();
  try {
    const { stream, size } = await storage.get(asset.storageKey);
    return new NextResponse(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      status: 200,
      headers: {
        "Content-Type": asset.mimeType,
        "Content-Length": String(size),
        "Cache-Control": "public, max-age=3600",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        // Drawn by the widget on the customer's site, so another origin may load it.
        "Cross-Origin-Resource-Policy": "cross-origin",
      },
    });
  } catch (err) {
    if (err instanceof MediaObjectNotFoundError) return notFound();
    throw err;
  }
}
