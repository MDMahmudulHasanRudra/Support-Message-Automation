import type { NextRequest } from "next/server";
import { markVisitorTyping, visitorFromToken, WebchatError } from "@/server/channels/webchat";
import { json, preflight, withWidget } from "../http";

/** The visitor is typing (sent at most every few seconds while they type). Shown to agents briefly. */
export const dynamic = "force-dynamic";

export function OPTIONS(request: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  return params.then(({ key }) => preflight(request, key));
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  return withWidget(request, key, async (widget, cors) => {
    const visitor = await visitorFromToken(widget, request.headers.get("authorization"));
    if (!visitor) throw new WebchatError("Chat session not found or expired.", 401);
    await markVisitorTyping(visitor);
    return json({ ok: true }, 200, cors);
  });
}
