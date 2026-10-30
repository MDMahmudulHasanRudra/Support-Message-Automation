import type { NextRequest } from "next/server";
import { recordVisitorMessage, visitorConversation, visitorFromToken, WebchatError } from "@/server/channels/webchat";
import { json, preflight, readJson, withWidget } from "../http";

/**
 * The visitor's own conversation: read sent messages (GET, `?seen=1` while the widget is open and in
 * view marks the team's replies read) and send one (POST). Bearer token required.
 */
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
    const seen = request.nextUrl.searchParams.get("seen") === "1";
    return json(await visitorConversation(widget, visitor, after && after.length <= 40 ? after : null, seen), 200, cors);
  });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  return withWidget(request, key, async (widget, cors) => {
    const visitor = await visitorFromToken(widget, request.headers.get("authorization"));
    if (!visitor) throw new WebchatError("Chat session not found or expired.", 401);
    const body = await readJson(request);
    const result = await recordVisitorMessage(widget, visitor, { text: body.text, nonce: body.nonce, pageUrl: body.pageUrl });
    return json({ ok: true, duplicate: result.duplicate }, 202, cors);
  });
}
