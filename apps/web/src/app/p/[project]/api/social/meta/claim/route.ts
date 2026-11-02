import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/server/auth";
import { checkPermission } from "@/server/authorize";
import { activeProjectSlug } from "@/server/projectContext";
import { logSystemEvent } from "@/server/logSystemEvent";
import { claimMetaSession, META_SOCIAL_BINDING_COOKIE, MetaOAuthError, metaBindingCookieOptions, visitorOrigin } from "@/server/channels/metaOAuth";
import { completeSocialMetaSession } from "@/server/social/metaConnect";
import { SocialAccountError } from "@/server/social/accounts";

/**
 * Back from Meta's publishing dialog, on the customer's own address (docs/meta-expansion/04 §2). The
 * result is handed over only to the person who started it, in the browser that started it, on the
 * address it started from, once: session + `social.manage` with Social Studio on + one-time claim code +
 * the Social Studio binding cookie. A messaging attempt's claim is not accepted here. Then the Pages are
 * read and the publishing connection saved; the attempt keeps no token.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const slug = await activeProjectSlug();
  const visited = visitorOrigin(request.headers, request.nextUrl);
  const origin = visited ?? request.nextUrl.origin;
  const back = (query: string) => {
    const response = NextResponse.redirect(`${origin}/p/${slug}/social/accounts?${query}`, 303);
    response.cookies.set(META_SOCIAL_BINDING_COOKIE, "", metaBindingCookieOptions(0));
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  };

  const session = await getSession();
  if (!session) return NextResponse.redirect(`${origin}/login`, 303);
  const access = await checkPermission("social.manage", { feature: "SOCIAL_STUDIO", sections: ["/social/accounts"] });
  if ("denied" in access) return back("social_error=permission");
  let sessionId: string;
  try {
    sessionId = await claimMetaSession({
      claim: request.nextUrl.searchParams.get("c") ?? "",
      binding: request.cookies.get(META_SOCIAL_BINDING_COOKIE)?.value,
      userId: session.userId,
      flow: "SOCIAL",
      origin: visited,
    });
  } catch (err) {
    if (err instanceof MetaOAuthError) return back(`social_error=${err.code}`);
    console.error("[social] could not claim the Facebook / Instagram authorisation", err);
    return back("social_error=failed");
  }
  try {
    const result = await completeSocialMetaSession({ sessionId, userId: session.userId, username: session.username });
    await logSystemEvent("INFO", "social", "Facebook / Instagram connected for publishing", result, { actorUserId: session.userId });
    return back(`connected=${result.active}&attention=${result.needsAttention}`);
  } catch (err) {
    // Never the message in the URL: it can carry Meta's raw response.
    await logSystemEvent("WARN", "social", "Connecting Facebook / Instagram for publishing failed", { error: (err as Error).message.slice(0, 300) }, { actorUserId: session.userId });
    return back(err instanceof SocialAccountError ? "social_error=meta" : "social_error=failed");
  }
}
