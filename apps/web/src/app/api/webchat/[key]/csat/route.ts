import type { NextRequest } from "next/server";
import { visitorFromToken, WebchatError } from "@/server/channels/webchat";
import { submitVisitorCsat } from "@/server/channels/webchatCsat";
import { json, preflight, readJson, withWidget } from "../http";

/**
 * The visitor's answer to a satisfaction survey card (CSAT.md): `{ surveyId, rating 1–5, comment? }`. Bearer
 * token required, origin checked like every other widget call (fails closed); only a survey of the visitor's
 * own conversation, once.
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
    const body = await readJson(request);
    await submitVisitorCsat(widget, visitor, { surveyId: body.surveyId, rating: body.rating, comment: body.comment });
    return json({ ok: true }, 200, cors);
  });
}
