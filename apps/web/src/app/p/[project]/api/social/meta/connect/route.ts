import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/server/auth";
import { checkPermission } from "@/server/authorize";
import { activeProjectId, activeProjectSlug } from "@/server/projectContext";
import { publicOrigin } from "@/server/google/oauth";
import { newSocialMetaState, sealSocialMetaState, socialMetaCookieOptions, socialMetaDialogUrl, socialMetaReadiness, SOCIAL_META_STATE_COOKIE, SOCIAL_META_STATE_TTL_MS } from "@/server/social/metaConnect";

/**
 * "Connect Facebook / Instagram" for publishing (SOCIAL_STUDIO.md §Meta). Checks the person may manage
 * Social Studio accounts here and that Meta publishing is set up for this workspace, seals the state into
 * an encrypted HTTP-only cookie scoped to the callback, and sends the browser to Meta's dialog.
 * A real navigation (the button is a link), never fetched.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const origin = publicOrigin() ?? new URL(request.url).origin;
  const slug = await activeProjectSlug();
  const back = (query: string) => NextResponse.redirect(`${origin}/p/${slug}/social/accounts?${query}`, 303);
  const session = await getSession();
  if (!session) return NextResponse.redirect(`${origin}/login`, 303);
  const access = await checkPermission("social.manage", { feature: "SOCIAL_STUDIO", sections: ["/social/accounts"] });
  if ("denied" in access || !slug) return back("social_error=permission");
  const ready = socialMetaReadiness(await activeProjectId());
  if (!ready.ok) return back("social_error=not_configured");
  const state = newSocialMetaState(slug, session.userId);
  const response = NextResponse.redirect(await socialMetaDialogUrl(state), 303);
  response.cookies.set(SOCIAL_META_STATE_COOKIE, sealSocialMetaState(state), socialMetaCookieOptions(Math.floor(SOCIAL_META_STATE_TTL_MS / 1000)));
  response.headers.set("Cache-Control", "no-store");
  return response;
}
