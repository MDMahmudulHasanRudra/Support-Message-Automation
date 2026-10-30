import type { NextRequest } from "next/server";
import { widgetAvailability } from "@/server/channels/webchat";
import { json, preflight, withWidget } from "./http";

/** The widget's public configuration: look, wording, whether it is accepting messages, and whether the team is in. */
export const dynamic = "force-dynamic";

export function OPTIONS(request: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  return params.then(({ key }) => preflight(request, key));
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  return withWidget(request, key, async (widget, cors) => {
    // The weekly hours stay on the server: the widget needs only whether the team is in, and when it is back.
    const settings: Partial<typeof widget.settings> = { ...widget.settings };
    delete settings.hours;
    return json({ name: widget.name, enabled: widget.enabled, settings, availability: widgetAvailability(widget) }, 200, cors);
  });
}
