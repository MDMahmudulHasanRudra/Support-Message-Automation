import { NextResponse, type NextRequest } from "next/server";
import { corsFor, loadPublicWidget, recordWidgetRefused, WebchatError, type PublicWidget } from "@/server/channels/webchat";

/**
 * Shared plumbing for the public website chat API (WEBSITE_CHAT.md): load the widget a key names,
 * refuse an origin it does not list, attach CORS headers, and turn errors into JSON a widget can show.
 * Never a stack trace, never which part of the check failed beyond what a visitor can act on.
 */
export const BASE_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

export function json(body: unknown, status: number, cors: Record<string, string> | null): NextResponse {
  return NextResponse.json(body, { status, headers: { ...BASE_HEADERS, ...(cors ?? {}) } });
}

export async function withWidget(
  request: NextRequest,
  key: string,
  run: (widget: PublicWidget, cors: Record<string, string>) => Promise<NextResponse>,
): Promise<NextResponse> {
  const widget = await loadPublicWidget(key);
  if (!widget) return json({ error: "Chat is not available." }, 404, null);
  const cors = corsFor(widget, request.headers.get("origin"));
  if (!cors) {
    // Remembered for the install page ("tried to start on https://x, which is not listed"); nothing else.
    await recordWidgetRefused(widget, request.headers.get("origin"));
    return json({ error: "This website may not use this chat." }, 403, null);
  }
  try {
    return await run(widget, cors);
  } catch (err) {
    if (err instanceof WebchatError) return json({ error: err.message }, err.status, cors);
    console.error("[webchat] request failed", err);
    return json({ error: "Something went wrong. Try again." }, 500, cors);
  }
}

export async function preflight(request: NextRequest, key: string): Promise<NextResponse> {
  const widget = await loadPublicWidget(key);
  const cors = widget ? corsFor(widget, request.headers.get("origin")) : null;
  return new NextResponse(null, { status: cors ? 204 : 403, headers: { ...BASE_HEADERS, ...(cors ?? {}) } });
}

export async function readJson(request: NextRequest): Promise<Record<string, unknown>> {
  if (Number(request.headers.get("content-length") ?? 0) > 16_000) throw new WebchatError("Too large.", 413);
  const text = await request.text();
  if (text.length > 16_000) throw new WebchatError("Too large.", 413);
  try {
    const value = JSON.parse(text || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    throw new WebchatError("Bad request.", 400);
  }
}

/** The client address as Caddy forwards it, for per-network rate limiting only. */
export function clientIp(request: NextRequest): string | null {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || null;
}
