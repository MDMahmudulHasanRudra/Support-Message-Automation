import { NextResponse, type NextRequest } from "next/server";
import { loadPublicWidget } from "@/server/channels/webchat";

export const dynamic = "force-dynamic";

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * A widget's own chat page (WEBSITE_CHAT.md): a link a business can share in a bio, an email or a QR code when
 * there is no website to paste the code into. The same widget and API, full screen; each browser is its own visitor.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const widget = await loadPublicWidget(key);
  if (!widget || !widget.settings.directLink) return new NextResponse("This chat link is not available.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  const title = escapeHtml(widget.settings.title || widget.name);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>html,body{height:100%;margin:0;background:#f4f7f8}</style>
</head>
<body>
<script src="/api/webchat/widget.js" data-key="${escapeHtml(key)}" data-direct="1" async></script>
<noscript>This chat needs JavaScript.</noscript>
</body>
</html>`;
  return new NextResponse(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
}
