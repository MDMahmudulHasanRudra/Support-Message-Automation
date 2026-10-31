import { Readable } from "node:stream";
import { NextResponse, type NextRequest } from "next/server";
import { MediaObjectNotFoundError } from "@support-automation/media-storage";
import { visitorAttachment, visitorFromToken, WebchatError } from "@/server/channels/webchat";
import { getMediaStorage } from "@/server/mediaStorage";
import { BASE_HEADERS, preflight, withWidget } from "../../../http";

/**
 * A file in the visitor's OWN conversation, for the widget (V3): their photo, or one the team sent. Authorised by
 * the visitor's bearer token (the widget fetches it and shows it as a blob), never a public or guessable address.
 * Another visitor's message, a reply not yet sent, or another project's key is a 404.
 */
export const dynamic = "force-dynamic";

export function OPTIONS(request: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  return params.then(({ key }) => preflight(request, key));
}

const asciiName = (name: string) => name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");

export async function GET(request: NextRequest, { params }: { params: Promise<{ key: string; messageId: string; index: string }> }) {
  const { key, messageId, index } = await params;
  return withWidget(request, key, async (widget, cors) => {
    const visitor = await visitorFromToken(widget, request.headers.get("authorization"));
    if (!visitor) throw new WebchatError("Chat session not found or expired.", 401);
    const file = await visitorAttachment(widget, visitor, messageId, Number(index));
    if (!file) throw new WebchatError("This file is not available.", 404);
    const storage = getMediaStorage();
    if (!storage) throw new WebchatError("Files cannot be shown right now.", 503);
    try {
      const { stream, size } = await storage.get(file.storageKey);
      return new NextResponse(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
        status: 200,
        headers: {
          ...BASE_HEADERS,
          ...cors,
          "Content-Type": file.mimeType,
          "Content-Length": String(size),
          "Cache-Control": "private, no-store",
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "Content-Disposition": `${file.mimeType === "application/pdf" ? "attachment" : "inline"}; filename="${asciiName(file.name)}"`,
        },
      });
    } catch (err) {
      if (err instanceof MediaObjectNotFoundError) throw new WebchatError("This file is no longer available.", 404);
      throw err;
    }
  });
}
