import { NextResponse, type NextRequest } from "next/server";
import { publicOrigin } from "@/server/google/oauth";

/**
 * RETIRED by Meta expansion A2 (docs/meta-expansion/04 §2). Social Studio now comes back through the
 * platform's one Meta callback (`/api/meta/oauth/callback`) and its own claim route, so this address
 * redeems nothing. It stays only so an attempt started before the update ends on a clear "start again"
 * instead of a 404, and clears the old state cookie. Once deployed it can be removed from the Meta app's
 * Valid OAuth Redirect URIs.
 */
export const dynamic = "force-dynamic";

const LEGACY_STATE_COOKIE = "softify-social-meta";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const origin = publicOrigin() ?? new URL(request.url).origin;
  const response = NextResponse.redirect(`${origin}/open?next=${encodeURIComponent("/social/accounts?social_error=expired")}`, 303);
  response.cookies.set(LEGACY_STATE_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/api/social/meta/callback", maxAge: 0 });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
