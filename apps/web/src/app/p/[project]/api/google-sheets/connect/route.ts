import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/server/auth";
import { checkPermission } from "@/server/authorize";
import { activeProjectSlug } from "@/server/projectContext";
import {
  authorizationUrl,
  newOAuthState,
  publicOrigin,
  sealOAuthState,
  STATE_COOKIE,
  STATE_TTL_MS,
  stateCookieOptions,
} from "@/server/google/oauth";
import { resolveProjectGoogleClient } from "@/server/google/clientConfig";

/**
 * "Connect Google Account" (GOOGLE_SHEETS.md, Phase 1). Starts Google's OAuth flow for THIS project:
 * checks the person may manage Google Sheets here, seals the state (random state, PKCE verifier,
 * project, user) into an encrypted, HTTP-only cookie, and sends the browser to Google's consent
 * screen. Google comes back to the one fixed callback, which reads the cookie.
 *
 * A real navigation (the button is a link), never fetched: the browser must leave for Google.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const origin = publicOrigin() ?? new URL(request.url).origin;
  const slug = await activeProjectSlug();
  const back = (query: string) => NextResponse.redirect(`${origin}/p/${slug}/settings/google-sheets?${query}`, 303);

  const session = await getSession();
  if (!session) return NextResponse.redirect(`${origin}/login`, 303);
  const access = await checkPermission("google_sheets.manage", "GOOGLE_SHEETS");
  if ("denied" in access || !slug) return back("google_error=permission");

  // This project's own client (or the server's fallback), and only while the integration is on.
  const client = await resolveProjectGoogleClient();
  if (!client.ok) return back(`google_error=${client.reason === "DISABLED" ? "disabled" : client.reason === "INVALID" ? "invalid_client" : "not_configured"}`);
  const config = client.config;

  const state = newOAuthState(slug, session.userId, Date.now(), "CONNECT", config.clientId);
  const response = NextResponse.redirect(authorizationUrl(config, state), 303);
  response.cookies.set(STATE_COOKIE, sealOAuthState(state), stateCookieOptions(Math.floor(STATE_TTL_MS / 1000)));
  response.headers.set("Cache-Control", "no-store");
  return response;
}
