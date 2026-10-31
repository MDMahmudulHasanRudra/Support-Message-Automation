import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { MediaObjectNotFoundError } from "@support-automation/media-storage";
import { isWebchatStorageKey, type ChannelAttachment } from "@support-automation/shared";
import { prisma } from "@/server/db";
import { getSession } from "@/server/auth";
import { checkPermission } from "@/server/authorize";
import { activeProjectId } from "@/server/projectContext";
import { getMediaStorage } from "@/server/mediaStorage";

/**
 * A file a website chat visitor sent (WEBSITE_CHAT.md §Files), for the project's own agents only:
 *
 *   1. a session, or 401;
 *   2. `messages.view` + Omnichannel in the URL's project, or 403;
 *   3. the message read through the PROJECT-SCOPED client (another project's id is a 404), and a
 *      storage key that is this project's website chat key, or 404.
 *
 * Only JPEG/PNG/WebP photos and PDFs were ever accepted from a visitor, and the type is taken from the
 * key's extension, which the upload decided from the bytes. A photo is served in a sandbox; a PDF opens
 * in the browser's own viewer (which does not run inside a sandboxed CSP).
 */
const HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
};
const SANDBOX_CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox";
const MIME: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp", pdf: "application/pdf" };

function refuse(status: number, message: string): NextResponse {
  return NextResponse.json({ error: message }, { status, headers: { ...HEADERS, "Cache-Control": "no-store" } });
}

function disposition(name: string): string {
  return `inline; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function GET(_request: Request, { params }: { params: Promise<{ messageId: string; index: string }> }) {
  if (!(await getSession())) return refuse(401, "Sign in to view this file.");
  const access = await checkPermission("messages.view", "OMNICHANNEL");
  if ("denied" in access) return refuse(403, access.denied);

  const { messageId, index } = await params;
  const position = Number(index);
  if (!Number.isInteger(position) || position < 0 || position > 20) return refuse(404, "This file is not available.");
  const message = await prisma.channelMessage.findFirst({ where: { id: messageId }, select: { attachments: true } });
  const list = Array.isArray(message?.attachments) ? (message.attachments as unknown as ChannelAttachment[]) : [];
  const attachment = list[position];
  const key = attachment?.storageKey;
  if (!key || !isWebchatStorageKey(key, await activeProjectId())) return refuse(404, "This file is not available.");

  const storage = getMediaStorage();
  if (!storage) return refuse(503, "Media storage is not configured on this server.");
  const extension = key.slice(key.lastIndexOf(".") + 1);
  const mime = MIME[extension] ?? "application/octet-stream";
  const name = (attachment.name ?? "").replace(/[\u0000-\u001f\u007f"\\/]/g, "").trim().slice(0, 180) || `website-chat-file.${extension}`;

  try {
    const { stream, size } = await storage.get(key);
    const headers: Record<string, string> = {
      ...HEADERS,
      "Content-Type": mime,
      "Content-Length": String(size),
      "Content-Disposition": disposition(name),
      "Cache-Control": "private, max-age=3600",
    };
    if (extension !== "pdf") headers["Content-Security-Policy"] = SANDBOX_CSP;
    return new NextResponse(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status: 200, headers });
  } catch (err) {
    if (err instanceof MediaObjectNotFoundError) return refuse(404, "This file is no longer in media storage.");
    console.error("[webchat] could not read a visitor file", messageId, (err as Error).name);
    return refuse(500, "The file could not be read from media storage.");
  }
}
