import { getBrandAsset } from "@/server/branding";
import { DEFAULT_ICON_SVG, isBrandAssetKind } from "@/lib/branding";

/**
 * The installation's logo and icon (BRANDING.md). Public on purpose: the sign-in page and the
 * browser tab need them before anyone is signed in, and a brand is not a secret.
 *
 * - The URL carries the version (`?v=`). When it matches the stored one the image is cached for good;
 *   any other request is revalidated, so a new upload is seen at once.
 * - The type served is the one sniffed from the bytes at upload, with `nosniff`, and every image is
 *   served under a sandboxing CSP: an SVG opened directly in a tab cannot run anything.
 * - No icon uploaded: the built-in one, from the same address, so the favicon never has two sources.
 */
export const dynamic = "force-dynamic";

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
} as const;

export async function GET(request: Request, { params }: { params: Promise<{ asset: string }> }): Promise<Response> {
  const { asset } = await params;
  if (!isBrandAssetKind(asset)) return new Response("Not found", { status: 404 });

  let stored: Awaited<ReturnType<typeof getBrandAsset>> = null;
  try {
    stored = await getBrandAsset(asset);
  } catch (err) {
    // Same fail-open as the pages: the built-in icon rather than a broken tab icon.
    console.warn("[branding] could not read a brand image", err);
  }

  const version = stored?.version ?? 0;
  const requested = new URL(request.url).searchParams.get("v");
  const cacheControl = requested === String(version) ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate";
  const hasImage = Boolean(stored && stored.bytes.length > 0 && stored.mimeType);
  const etag = `"brand-${asset}-${version}-${hasImage ? "custom" : "default"}"`;

  if (!hasImage && asset === "logo") {
    return new Response("No logo uploaded", { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": cacheControl } });
  }

  const body = hasImage ? new Uint8Array(stored!.bytes) : new TextEncoder().encode(DEFAULT_ICON_SVG);
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": hasImage ? stored!.mimeType : "image/svg+xml",
      "Content-Length": String(body.byteLength),
      "Cache-Control": cacheControl,
      ETag: etag,
      ...SECURITY_HEADERS,
    },
  });
}
