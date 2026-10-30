import type { NextRequest } from "next/server";
import { WEBCHAT_ATTACHMENT_MAX_BYTES } from "@support-automation/shared";
import { recordVisitorFile, visitorFromToken, WebchatError } from "@/server/channels/webchat";
import { json, preflight, withWidget } from "../http";

/**
 * A photo or PDF from the visitor (multipart form: `file`, optional `pageUrl`). The type is read from the
 * bytes; anything else is refused. The file is never served back publicly.
 */
export const dynamic = "force-dynamic";

export function OPTIONS(request: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  return params.then(({ key }) => preflight(request, key));
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  return withWidget(request, key, async (widget, cors) => {
    const visitor = await visitorFromToken(widget, request.headers.get("authorization"));
    if (!visitor) throw new WebchatError("Chat session not found or expired.", 401);
    if (Number(request.headers.get("content-length") ?? 0) > WEBCHAT_ATTACHMENT_MAX_BYTES + 64_000) throw new WebchatError("Files can be at most 10 MB.", 413);
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new WebchatError("Bad request.", 400);
    }
    const file = form.get("file");
    if (!(file instanceof File)) throw new WebchatError("Choose a file first.", 400);
    if (file.size > WEBCHAT_ATTACHMENT_MAX_BYTES) throw new WebchatError("Files can be at most 10 MB.", 413);
    const bytes = Buffer.from(await file.arrayBuffer());
    const result = await recordVisitorFile(widget, visitor, { bytes, fileName: file.name, pageUrl: form.get("pageUrl") });
    return json({ ok: true, name: result.name }, 202, cors);
  });
}
