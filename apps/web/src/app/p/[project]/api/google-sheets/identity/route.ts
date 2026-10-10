import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/server/auth";
import { checkPermission } from "@/server/authorize";
import { activeProjectSlug } from "@/server/projectContext";
import {
  authorizationUrl,
  googleOAuthConfig,
  newOAuthState,
  publicOrigin,
  sealOAuthState,
  STATE_COOKIE,
  STATE_TTL_MS,
  stateCookieOptions,
} from "@/server/google/oauth";

/**
 * "Link my Google account" (GOOGLE_SHEETS.md §5, Phase 4). Sends the signed-in person to Google's
 * account chooser to prove which Google account is THEIR OWN — openid and email only, no offline
 * access. The callback (the one fixed address) records it for this person and nobody else.
 *
 * Needs only the view key in this project with the feature on: linking your own identity changes
 * nothing for anyone else, and an identity is what lets an edit you make in Google be credited to you.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const origin = publicOrigin() ?? new URL(request.url).origin;
  const slug = await activeProjectSlug();
  const back = (query: string) => NextResponse.redirect(`${origin}/p/${slug}/google-sheets/identity?${query}`, 303);

  const session = await getSession();
  if (!session) return NextResponse.redirect(`${origin}/login`, 303);
  const access = await checkPermission("google_sheets.view", "GOOGLE_SHEETS");
  if ("denied" in access || !slug) return back("google_error=permission");

  const config = googleOAuthConfig();
  if (!config) return back("google_error=not_configured");

  const state = newOAuthState(slug, session.userId, Date.now(), "IDENTITY");
  const response = NextResponse.redirect(authorizationUrl(config, state), 303);
  response.cookies.set(STATE_COOKIE, sealOAuthState(state), stateCookieOptions(Math.floor(STATE_TTL_MS / 1000)));
  response.headers.set("Cache-Control", "no-store");
  return response;
}
