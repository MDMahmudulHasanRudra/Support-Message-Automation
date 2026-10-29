import type { NextRequest } from "next/server";
import { json, preflight, withWidget } from "./http";

/** The widget's public configuration: look, wording, whether it is accepting messages. */
export const dynamic = "force-dynamic";

export function OPTIONS(request: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  return params.then(({ key }) => preflight(request, key));
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  return withWidget(request, key, async (widget, cors) => json({ name: widget.name, enabled: widget.enabled, settings: widget.settings }, 200, cors));
}
