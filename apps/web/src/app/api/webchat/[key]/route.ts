import type { NextRequest } from "next/server";
import { publicWidgetSettings, recordWidgetSeen, widgetAvailability } from "@/server/channels/webchat";
import { json, preflight, withWidget } from "./http";

/**
 * The widget's public configuration: look, wording, whether it is accepting messages, and whether the team is in.
 * Each successful load is also the installation check's evidence (V3): the listed website it ran on and the script
 * version, at most one write a minute.
 */
export const dynamic = "force-dynamic";

export function OPTIONS(request: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  return params.then(({ key }) => preflight(request, key));
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  return withWidget(request, key, async (widget, cors) => {
    await recordWidgetSeen(widget, request.headers.get("origin"), request.nextUrl.searchParams.get("v"));
    // The weekly hours, uploaded files' storage keys and consent records stay on the server.
    return json({ name: widget.name, enabled: widget.enabled, settings: publicWidgetSettings(widget), availability: widgetAvailability(widget) }, 200, cors);
  });
}
