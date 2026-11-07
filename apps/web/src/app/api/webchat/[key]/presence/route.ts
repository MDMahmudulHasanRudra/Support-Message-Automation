import type { NextRequest } from "next/server";
import { pageOn } from "@/server/channels/webchat";
import { recordPresence } from "@/server/channels/webchatPresence";
import { json, preflight, readJson, withWidget } from "../http";

/** "Somebody is on this page": anonymous, in memory, only for a widget that has it switched on. */
export const dynamic = "force-dynamic";

export function OPTIONS(request: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  return params.then(({ key }) => preflight(request, key));
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  return withWidget(request, key, async (widget, cors) => {
    if (!widget.settings.visitorPresence) return json({ ok: false }, 200, cors);
    const body = await readJson(request);
    recordPresence(widget.connectionId, body.pid, pageOn(widget, body.pageUrl), body.chatting === true);
    return json({ ok: true }, 200, cors);
  });
}
