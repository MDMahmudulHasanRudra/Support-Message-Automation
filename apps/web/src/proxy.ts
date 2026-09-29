import { NextResponse, type NextRequest } from "next/server";
import {
  isOutsideProject,
  LAST_PROJECT_COOKIE,
  PROJECT_HEADER,
  PROJECT_PATH_HEADER,
  slugFromPath,
  stripProjectPrefix,
  WORKSPACE_HEADER,
} from "@/lib/projectPaths";
import { parseWorkspacePath, WORKSPACE_PROJECT_COOKIE, WORKSPACE_SEGMENT_MARKER } from "@/lib/workspace";

/**
 * Carries the URL's project to the server, and keeps old URLs working (MULTI_PROJECT_PLAN.md §4.1).
 *
 * - `/p/<slug>/…`: forwards `<slug>` in PROJECT_HEADER. Any copy of that header the client sent is
 *   discarded first, so the project always comes from the URL — never from something a caller can
 *   set. Server Actions POST to the page's own URL, so they carry it too. Whether the user may
 *   enter that project is decided on the server (server/projectContext.ts), not here.
 * - `/admin/workspace/<slug>/…` (the Main Admin Workspace, lib/workspace.ts): REWRITTEN to
 *   the same project page (`/p/<slug>~ws/…`, see WORKSPACE_SEGMENT_MARKER), with the SAME project headers taken from the same URL segment, plus
 *   WORKSPACE_HEADER. So the page that renders is the project page itself and is checked exactly
 *   like it; only the dashboard layout's chrome differs. The browser keeps the workspace URL, so
 *   Server Actions post back to it and are rewritten the same way.
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
  forwarded.delete(PROJECT_PATH_HEADER);
  forwarded.delete(WORKSPACE_HEADER);

  const slug = slugFromPath(pathname);
  if (slug) {
    forwarded.set(PROJECT_HEADER, slug);
    forwarded.set(PROJECT_PATH_HEADER, stripProjectPrefix(pathname));
    const response = NextResponse.next({ request: { headers: forwarded } });
    if (request.cookies.get(LAST_PROJECT_COOKIE)?.value !== slug) {
      response.cookies.set(LAST_PROJECT_COOKIE, slug, { path: "/", sameSite: "lax", httpOnly: true, maxAge: 60 * 60 * 24 * 365 });
    }
    return response;
  }

  const workspace = parseWorkspacePath(pathname);
  if (workspace) {
    forwarded.set(PROJECT_HEADER, workspace.slug);
    forwarded.set(PROJECT_PATH_HEADER, workspace.projectPath);
    forwarded.set(WORKSPACE_HEADER, "1");
    const target = new URL(`/p/${workspace.slug}${WORKSPACE_SEGMENT_MARKER}${workspace.projectPath === "/" ? "" : workspace.projectPath}${search}`, request.url);
    const response = NextResponse.rewrite(target, { request: { headers: forwarded } });
    if (request.cookies.get(WORKSPACE_PROJECT_COOKIE)?.value !== workspace.slug) {
      response.cookies.set(WORKSPACE_PROJECT_COOKIE, workspace.slug, { path: "/admin", sameSite: "lax", httpOnly: true, maxAge: 60 * 60 * 24 * 365 });
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
