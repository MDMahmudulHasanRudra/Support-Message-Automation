import { NextResponse, type NextRequest } from "next/server";
import { isOutsideProject, LAST_PROJECT_COOKIE, PROJECT_HEADER, slugFromPath } from "@/lib/projectPaths";

/**
 * Carries the URL's project to the server, and keeps old URLs working (MULTI_PROJECT_PLAN.md §4.1).
 *
 * - `/p/<slug>/…`: forwards `<slug>` in PROJECT_HEADER. Any copy of that header the client sent is
 *   discarded first, so the project always comes from the URL — never from something a caller can
 *   set. Server Actions POST to the page's own URL, so they carry it too. Whether the user may
 *   enter that project is decided on the server (server/projectContext.ts), not here.
 * - A pre-multi-project URL (`/rules`, a bookmark): sent to `/open`, which picks a project the
 *   user can enter and continues to the same page inside it.
 *
 * The last project opened is remembered in a cookie for that redirect only. It never decides where
 * a request reads or writes — a cookie is shared by every tab, the URL is not.
 */

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const forwarded = new Headers(request.headers);
  forwarded.delete(PROJECT_HEADER);

  const slug = slugFromPath(pathname);
  if (slug) {
    forwarded.set(PROJECT_HEADER, slug);
    const response = NextResponse.next({ request: { headers: forwarded } });
    if (request.cookies.get(LAST_PROJECT_COOKIE)?.value !== slug) {
      response.cookies.set(LAST_PROJECT_COOKIE, slug, { path: "/", sameSite: "lax", httpOnly: true, maxAge: 60 * 60 * 24 * 365 });
    }
    return response;
  }

  if (pathname !== "/" && !isOutsideProject(pathname) && !pathname.startsWith("/api/")) {
    const target = new URL("/open", request.url);
    target.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(target);
  }

  return NextResponse.next({ request: { headers: forwarded } });
}

export const config = {
  // Everything except framework assets and the static icon.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
