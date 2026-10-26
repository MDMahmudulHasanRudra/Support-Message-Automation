import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/server/auth";
import { checkPermission } from "@/server/authorize";
import { activeProjectSlug } from "@/server/projectContext";
import { currentHostScope } from "@/server/hostScope";
import { META_BINDING_COOKIE, META_CHOICE_TTL_MS, META_STATE_TTL_MS, MetaOAuthError, metaBindingCookieOptions, startMetaOAuth, visitorOrigin } from "@/server/channels/metaOAuth";

/**
 * "Connect with Facebook" / "Reconnect with Facebook" (docs/meta-integration/05). Starts Meta's
 * authorisation for THIS project and sends the browser to Meta's dialog. A real navigation, never
 * fetched: the browser has to leave for Meta.
 *
 *   ?type=MESSENGER|INSTAGRAM   what the person asked for (both are offered when they come back)
 *   ?reconnect=<connectionId>   reconnect that connection
 *
 * The address the person started from is where they come back to. It must be one this installation
 * serves projects on — a customer's own address or an open one — never the platform's.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const slug = await activeProjectSlug();
  const origin = visitorOrigin(request.headers, request.nextUrl);
  const settings = (query: string) => NextResponse.redirect(`${origin ?? ""}/p/${slug}/settings/channels?${query}`, 303);

  const session = await getSession();
  if (!session) return NextResponse.redirect(`${origin ?? ""}/login`, 303);
  if (!slug || !origin) return settings("meta_error=permission");
  const scope = await currentHostScope();
  if (scope.kind !== "OPEN" && scope.kind !== "CUSTOMER") return settings("meta_error=permission");
  const access = await checkPermission("channels.manage");
  if ("denied" in access) return settings("meta_error=permission");

  const params = request.nextUrl.searchParams;
  const type = params.get("type");
  const reconnect = params.get("reconnect");
  try {
    const started = await startMetaOAuth({
      userId: session.userId,
      purpose: reconnect ? "RECONNECT" : "CONNECT",
      channelType: type === "MESSENGER" || type === "INSTAGRAM" ? type : null,
      connectionId: reconnect && /^[a-z0-9]{10,40}$/i.test(reconnect) ? reconnect : null,
      returnOrigin: origin,
      returnPath: `/p/${slug}`,
    });
    const response = NextResponse.redirect(started.dialogUrl, 303);
    // Long enough to cover the dialog and the choice screen; cleared when the claim is made.
    response.cookies.set(META_BINDING_COOKIE, started.binding, metaBindingCookieOptions(Math.floor((META_STATE_TTL_MS + META_CHOICE_TTL_MS) / 1000)));
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (err) {
    if (err instanceof MetaOAuthError) return settings(`meta_error=${err.code}`);
    console.error("[meta] could not start the Facebook connection", err);
    return settings("meta_error=exchange_failed");
  }
}
