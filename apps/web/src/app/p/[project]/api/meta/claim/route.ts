import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/server/auth";
import { checkPermission } from "@/server/authorize";
import { activeProjectSlug } from "@/server/projectContext";
import { claimMetaSession, META_BINDING_COOKIE, MetaOAuthError, metaBindingCookieOptions, visitorOrigin } from "@/server/channels/metaOAuth";

/**
 * Back from Meta, on the customer's own address (docs/meta-integration/05, step 3). The result of the
 * authorisation is handed over only to the person who started it, in the browser that started it:
 * session + one-time claim code + the HTTP-only binding cookie. Then the choice screen opens.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const slug = await activeProjectSlug();
  const origin = visitorOrigin(request.headers, request.nextUrl) ?? request.nextUrl.origin;
  const base = `${origin}/p/${slug}/settings/channels`;
  const back = (path: string) => {
    const response = NextResponse.redirect(`${base}${path}`, 303);
    response.cookies.set(META_BINDING_COOKIE, "", metaBindingCookieOptions(0));
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  };

  const session = await getSession();
  if (!session) return NextResponse.redirect(`${origin}/login`, 303);
  const access = await checkPermission("channels.manage");
  if ("denied" in access) return back("?meta_error=permission");
  try {
    const sessionId = await claimMetaSession({
      claim: request.nextUrl.searchParams.get("c") ?? "",
      binding: request.cookies.get(META_BINDING_COOKIE)?.value,
      userId: session.userId,
    });
    return back(`/meta/${sessionId}`);
  } catch (err) {
    if (err instanceof MetaOAuthError) return back(`?meta_error=${err.code}`);
    console.error("[meta] could not claim the Facebook authorisation", err);
    return back("?meta_error=exchange_failed");
  }
}
