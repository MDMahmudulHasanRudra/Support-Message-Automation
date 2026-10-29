import type { NextRequest } from "next/server";
import { recordVisitorMessage, visitorFromToken, visitorMessages, WebchatError } from "@/server/channels/webchat";
import { json, preflight, readJson, withWidget } from "../http";

/** The visitor's own conversation: read sent messages (GET) and send one (POST). Bearer token required. */
export const dynamic = "force-dynamic";

export function OPTIONS(request: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  return params.then(({ key }) => preflight(request, key));
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  return withWidget(request, key, async (widget, cors) => {
    const visitor = await visitorFromToken(widget, request.headers.get("authorization"));
    if (!visitor) throw new WebchatError("Chat session not found or expired.", 401);
    const after = request.nextUrl.searchParams.get("after");
    return json({ messages: await visitorMessages(widget, visitor, after && after.length <= 40 ? after : null) }, 200, cors);
  });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  return withWidget(request, key, async (widget, cors) => {
    const visitor = await visitorFromToken(widget, request.headers.get("authorization"));
    if (!visitor) throw new WebchatError("Chat session not found or expired.", 401);
    const body = await readJson(request);
    const result = await recordVisitorMessage(widget, visitor, { text: body.text, nonce: body.nonce });
    return json({ ok: true, duplicate: result.duplicate }, 202, cors);
  });
}
