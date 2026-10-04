import { Readable } from "node:stream";
import { NextResponse, type NextRequest } from "next/server";
import { MediaObjectNotFoundError, parseRangeHeader } from "@support-automation/media-storage";
import { inlineMediaKind } from "@support-automation/shared";
import { prisma } from "@/server/db";
import { getSession } from "@/server/auth";
import { checkPermission } from "@/server/authorize";
import { getMediaStorage } from "@/server/mediaStorage";

/**
 * Serves one stored WhatsApp attachment (MEDIA_STORAGE.md) — the only way a media file leaves
 * storage. There is no public URL for any file: every request is checked here, every time.
 *
 *   1. a session, or 401;
 *   2. the URL's project, the user's access to it, `messages.view` (the key that opens the WhatsApp
 *      chat) and the project's WhatsApp Chat feature, or 403;
 *   3. the media row, read through the PROJECT-SCOPED client — another project's id reads as not
 *      found, exactly like an id that does not exist — and it must still be STORED and still belong
 *      to the message and account it was recorded with, or 404.
 *
 * Streamed from storage, never buffered, with HTTP Range support so a browser can seek in a long
 * video or voice note without downloading all of it. Only types a browser renders as media are
 * served inline (images, video, audio, PDF); everything else — HTML, SVG, executables, archives — is
 * an attachment download, so nothing a customer sent can run in the dashboard's origin.
 */

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
};
/** Media and PDFs are rendered by the browser itself; nothing else is ever rendered at all. */
const SANDBOX_CSP = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox";

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/3gpp": ".3gp",
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "application/pdf": ".pdf",
};

/** A download name: the sender's file name when there was one, cleaned for a header; otherwise made up from the type. */
function downloadName(fileName: string | null, mediaType: string, mimeType: string | null, id: string): string {
  const cleaned = (fileName ?? "").replace(/[\u0000-\u001f\u007f"\\/]/g, "").trim().slice(0, 180);
  if (cleaned) return cleaned;
  const base = (mimeType ?? "").split(";")[0]!.trim().toLowerCase();
  return `whatsapp-${mediaType.toLowerCase()}-${id}${EXTENSIONS[base] ?? ""}`;
}

function disposition(kind: "inline" | "attachment", name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function refuse(status: number, message: string): NextResponse {
  return NextResponse.json({ error: message }, { status, headers: { ...SECURITY_HEADERS, "Cache-Control": "no-store" } });
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ mediaId: string }> }) {
  if (!(await getSession())) return refuse(401, "Sign in to view this file.");
  const access = await checkPermission("messages.view", "WHATSAPP_CHAT");
  if ("denied" in access) return refuse(403, access.denied);

  const { mediaId } = await params;
  const media = await prisma.messageMedia.findUnique({
    where: { id: mediaId },
    select: {
      id: true,
      status: true,
      mediaType: true,
      mimeType: true,
      fileName: true,
      storageKey: true,
      thumbnailKey: true,
      sha256: true,
      accountId: true,
      groupId: true,
      message: { select: { accountId: true, groupId: true } },
    },
  });
  // The row must still describe the message it was recorded with: same account, same group.
  if (
    !media ||
    media.status !== "STORED" ||
    media.message.accountId !== media.accountId ||
    (media.groupId !== null && media.message.groupId !== media.groupId)
  ) {
    return refuse(404, "This file is not available.");
  }

  const wantsThumbnail = request.nextUrl.searchParams.get("variant") === "thumbnail";
  const key = wantsThumbnail ? media.thumbnailKey : media.storageKey;
  if (!key) return refuse(404, "This file is not available.");

  const storage = getMediaStorage();
  if (!storage) return refuse(503, "Media storage is not configured on this server.");

  const etag = `"${media.sha256 ?? media.id}${wantsThumbnail ? "-t" : ""}"`;
  if (request.headers.get("if-none-match") === etag) {
    return new NextResponse(null, { status: 304, headers: { ...SECURITY_HEADERS, ETag: etag, "Cache-Control": "private, max-age=86400" } });
  }

  const stat = await storage.stat(key);
  if (!stat) return refuse(404, "This file is no longer in media storage.");

  const contentType = wantsThumbnail ? "image/jpeg" : media.mimeType ?? "application/octet-stream";
  const inline = wantsThumbnail ? "image" : inlineMediaKind(media.mimeType);
  const forceDownload = request.nextUrl.searchParams.get("download") === "1";
  const headers: Record<string, string> = {
    ...SECURITY_HEADERS,
    "Content-Type": inline ? contentType : "application/octet-stream",
    "Content-Disposition": disposition(
      inline && !forceDownload ? "inline" : "attachment",
      downloadName(media.fileName, media.mediaType, media.mimeType, media.id),
    ),
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=86400",
    ETag: etag,
  };
  // The browser's PDF viewer does not run inside a sandboxed CSP; everything else gets one.
  if (inline !== "pdf") headers["Content-Security-Policy"] = SANDBOX_CSP;

  const range = parseRangeHeader(request.headers.get("range"), stat.size);
  if (range === "unsatisfiable") {
    return new NextResponse(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${stat.size}` } });
  }

  try {
    const { stream } = await storage.get(key, range ?? undefined);
    const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
    if (range) {
      return new NextResponse(body, {
        status: 206,
        headers: { ...headers, "Content-Range": `bytes ${range.start}-${range.end}/${stat.size}`, "Content-Length": String(range.end - range.start + 1) },
      });
    }
    return new NextResponse(body, { status: 200, headers: { ...headers, "Content-Length": String(stat.size) } });
  } catch (err) {
    if (err instanceof MediaObjectNotFoundError) return refuse(404, "This file is no longer in media storage.");
    console.error("[media] could not read a stored file", media.id, err);
    return refuse(500, "The file could not be read from media storage.");
  }
}
