import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { getSession } from "@/server/auth";
import { checkPermission } from "@/server/authorize";
import { avatarsEnabled } from "@/server/whatsappPictures";

/**
 * A WhatsApp profile picture or group icon (WHATSAPP_AVATARS.md). Session → project access →
 * `messages.view` with WHATSAPP_CHAT (the chat's own gate) → the project's WHATSAPP_AVATARS feature
 * and the server's emergency switch → the row through the project-scoped client, so another
 * project's id is a 404. The bytes were type-sniffed, size-checked and stripped of metadata by the
 * worker; they are served with that type, `nosniff` and a sandboxing CSP, privately cached briefly
 * and keyed by `?v=` so a new picture shows at once. WhatsApp's own address is never sent.
 */
export const dynamic = "force-dynamic";

const HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; sandbox",
} as const;

const refuse = (status: number, text: string) => new NextResponse(text, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getSession())) return refuse(401, "Sign in to view this picture.");
  const access = await checkPermission("messages.view", "WHATSAPP_CHAT");
  if ("denied" in access) return refuse(403, access.denied);
  if (!(await avatarsEnabled())) return refuse(404, "No picture");
  const { id } = await params;
  const picture = await prisma.whatsAppPicture.findFirst({ where: { id }, select: { mimeType: true, bytes: true, storedAt: true } });
  if (!picture?.bytes || !picture.mimeType || !picture.storedAt) return refuse(404, "No picture");
  const etag = `"wa-picture-${id}-${picture.storedAt.getTime()}"`;
  if (request.headers.get("if-none-match") === etag) return new NextResponse(null, { status: 304, headers: { ETag: etag } });
  const body = new Uint8Array(picture.bytes);
  return new NextResponse(body, {
    status: 200,
    headers: { "Content-Type": picture.mimeType, "Content-Length": String(body.byteLength), "Cache-Control": "private, max-age=300", ETag: etag, ...HEADERS },
  });
}
