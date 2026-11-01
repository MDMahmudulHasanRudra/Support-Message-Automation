import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/server/auth";
import { checkPermission } from "@/server/authorize";
import { activeProjectId, activeProjectSlug } from "@/server/projectContext";
import { currentHostScope } from "@/server/hostScope";
import { META_CHOICE_TTL_MS, META_SOCIAL_BINDING_COOKIE, META_STATE_TTL_MS, MetaOAuthError, metaBindingCookieOptions, startMetaOAuth, visitorOrigin } from "@/server/channels/metaOAuth";
import { socialMetaReadiness } from "@/server/social/metaConnect";

/**
 * "Connect Facebook / Instagram" for publishing (SOCIAL_STUDIO.md §Meta, docs/meta-expansion/04 §2).
 * Starts a SOCIAL_CONNECT attempt through the platform's secure handover (`metaOAuth.ts`): the state is
 * stored only as a hash, this browser gets its own HTTP-only binding cookie, and the person comes back
 * through the platform's one callback to the address they started from. A real navigation (the button is
 * a link), never fetched.
 *
 * The address the person started from must be one this installation serves projects on — a customer's own
 * address or an open one — never the platform's.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const slug = await activeProjectSlug();
  const origin = visitorOrigin(request.headers, request.nextUrl);
  const back = (query: string) => NextResponse.redirect(`${origin ?? ""}/p/${slug}/social/accounts?${query}`, 303);
  const session = await getSession();
  if (!session) return NextResponse.redirect(`${origin ?? ""}/login`, 303);
  if (!slug || !origin) return back("social_error=permission");
  const scope = await currentHostScope();
  if (scope.kind !== "OPEN" && scope.kind !== "CUSTOMER") return back("social_error=permission");
  const access = await checkPermission("social.manage", { feature: "SOCIAL_STUDIO", sections: ["/social/accounts"] });
  if ("denied" in access) return back("social_error=permission");
  if (!socialMetaReadiness(await activeProjectId()).ok) return back("social_error=not_configured");
  try {
    const started = await startMetaOAuth({ userId: session.userId, purpose: "SOCIAL_CONNECT", channelType: null, connectionId: null, returnOrigin: origin, returnPath: `/p/${slug}` });
    const response = NextResponse.redirect(started.dialogUrl, 303);
    response.cookies.set(META_SOCIAL_BINDING_COOKIE, started.binding, metaBindingCookieOptions(Math.floor((META_STATE_TTL_MS + META_CHOICE_TTL_MS) / 1000)));
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (err) {
    if (err instanceof MetaOAuthError) return back(`social_error=${err.code}`);
    console.error("[social] could not start the Facebook / Instagram connection", err);
    return back("social_error=failed");
  }
}
