import type { NextRequest } from "next/server";
import { startVisitor } from "@/server/channels/webchat";
import { clientIp, json, preflight, readJson, withWidget } from "../http";

/** Starts (or resumes) a visitor. Returns a token only when a new visitor was created. */
export const dynamic = "force-dynamic";

export function OPTIONS(request: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  return params.then(({ key }) => preflight(request, key));
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  return withWidget(request, key, async (widget, cors) => {
    const body = await readJson(request);
    const session = await startVisitor(widget, { token: body.token, name: body.name, email: body.email, identity: body.identity, ip: clientIp(request) });
    return json({ token: session.token, verified: session.verified }, 200, cors);
  });
}
