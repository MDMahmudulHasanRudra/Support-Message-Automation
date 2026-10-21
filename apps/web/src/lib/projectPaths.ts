/**
 * Project-aware URLs (MULTI_PROJECT_PLAN.md §4.1). Every page of the app lives at
 * `/p/<project-slug>/<page>`. The app's own links are still written project-relative ("/rules"),
 * and are prefixed with the CURRENT project where they are rendered — so no page has to know its
 * project, and a link can never point into a project other than the one it was rendered in.
 *
 * Pure and shared by the server helpers, the client `Link`/router wrappers and `proxy.ts`.
 */

import { parseWorkspacePath, workspaceHref } from "@/lib/workspace";

/** Request header carrying the URL's project slug. Set ONLY by proxy.ts, which strips any incoming copy. */
export const PROJECT_HEADER = "x-softify-project";

/**
 * Request header carrying the path INSIDE the project ("/chat/abc"), so the server can tell which
 * project feature a page or a Server Action belongs to (MULTI_PROJECT_PLAN.md §9). Set ONLY by
 * proxy.ts, which strips any incoming copy. Deciding by it can only ever REFUSE more.
 */
export const PROJECT_PATH_HEADER = "x-softify-project-path";

/**
 * Request header saying the request came through the Main Admin Workspace (lib/workspace.ts), so the
 * dashboard layout draws the workspace chrome and a `redirect` stays in the workspace. Set ONLY by
 * proxy.ts, which strips any incoming copy. It changes which chrome and which URL shape — never the
 * project, which still comes from the same URL segment.
 */
export const WORKSPACE_HEADER = "x-softify-workspace";

/**
 * The hostname the request was made to, as the proxy read it from `Host` (SAAS_PLATFORM_PLAN.md
 * §3.3). Always overwritten by the proxy, never taken from a client. Trusted because the app port is
 * reachable only through the reverse proxy, which passes the browser's hostname on.
 */
export const HOST_HEADER = "x-nexora-host";

/**
 * The address the visitor used, for the proxy to forward as HOST_HEADER. `x-forwarded-host` first:
 * Next sets it from `Host` on every request that arrives without one, the reverse proxy sets it to
 * the visitor's address, and Next's own render of a Server Action's redirect target — a request
 * from this server to itself, `Host: localhost` — carries the original value forward. Reading `Host`
 * alone made that render look like localhost, so a session bound to the real address read as signed
 * out and every sign-in on a named address bounced back to /login. Trusting the header adds nothing
 * an outside caller could not already do with `Host`; in production only the reverse proxy reaches the app.
 */
export function visitedHost(headers: Headers): string {
  return (headers.get("x-forwarded-host") ?? headers.get("host") ?? "").split(",")[0]!.trim().toLowerCase();
}

/** Remembers the last project opened, ONLY so `/open` can continue there. Never decides reads or writes. */
export const LAST_PROJECT_COOKIE = "softify-last-project";

/**
 * Paths that are not inside a project: sign-in, the project chooser, the Main Admin Portal, health,
 * framework assets. A link to one of these is never prefixed with the current project.
 */
const OUTSIDE_PROJECT = [
  /^\/login(\/|$|\?)/,
  /^\/open(\/|$|\?)/,
  /^\/invite\//,
  /^\/admin(\/|$|\?)/,
  /^\/api\/health(\/|$|\?)/,
  /^\/p\//,
  /^\/_next\//,
];

export function isOutsideProject(path: string): boolean {
  return OUTSIDE_PROJECT.some((re) => re.test(path));
}

const SLUG_RE = /^\/p\/([a-z0-9][a-z0-9-]{0,62})(?=\/|$|\?)/;

/** The slug in a `/p/<slug>/…` path, or null. */
export function slugFromPath(path: string): string | null {
  return SLUG_RE.exec(path)?.[1] ?? null;
}

/**
 * `/rules` → `/p/isp-digital/rules`. Leaves external, relative, hash and outside-project URLs alone.
 *
 * Inside the Main Admin Workspace (`inWorkspace`) the same path is written as a workspace URL of the
 * same project (`/chat/abc` → `/admin/workspace/isp-digital/chat/abc`), so moving between modules
 * keeps both the workspace and the selected project.
 */
export function projectHref(href: string, slug: string | null | undefined, inWorkspace = false): string {
  if (!slug || !href.startsWith("/") || href.startsWith("//") || isOutsideProject(href)) return href;
  if (inWorkspace) return workspaceHref(href, slug);
  return `/p/${slug}${href === "/" ? "" : href}`;
}

/**
 * `/p/isp-digital/rules/42` → `/rules/42`: what the navigation's active-state logic compares against.
 * A workspace URL gives the page inside its project (`/admin/workspace/isp-digital/chat/abc` → `/chat/abc`).
 */
export function stripProjectPrefix(pathname: string): string {
  const workspace = parseWorkspacePath(pathname);
  if (workspace) return workspace.projectPath;
  const match = SLUG_RE.exec(pathname);
  if (!match) return pathname;
  const rest = pathname.slice(match[0].length);
  return rest === "" ? "/" : rest;
}
