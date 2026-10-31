import { WIDGET_SCRIPT } from "@/server/channels/webchatWidgetScript";

/**
 * The website chat widget script (WEBSITE_CHAT.md). Public and the same for every widget — the
 * `data-key` on the script tag names the widget, and every API call is checked against that widget's
 * allowed origins. Cached for an hour so a busy site does not fetch it on every page view.
 */
export const dynamic = "force-static";

export function GET(): Response {
  return new Response(WIDGET_SCRIPT, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
