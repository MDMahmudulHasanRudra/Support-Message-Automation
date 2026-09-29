/**
 * Project-aware URLs (MULTI_PROJECT_PLAN.md §4.1). Every page of the app lives at
 * `/p/<project-slug>/<page>`. The app's own links are still written project-relative ("/rules"),
 * and are prefixed with the CURRENT project where they are rendered — so no page has to know its
 * project, and a link can never point into a project other than the one it was rendered in.
 *
 * Pure and shared by the server helpers, the client `Link`/router wrappers and `proxy.ts`.
 */

/** Request header carrying the URL's project slug. Set ONLY by proxy.ts, which strips any incoming copy. */
export const PROJECT_HEADER = "x-softify-project";

/**
 * Request header carrying the path INSIDE the project ("/chat/abc"), so the server can tell which
 * project feature a page or a Server Action belongs to (MULTI_PROJECT_PLAN.md §9). Set ONLY by
 * proxy.ts, which strips any incoming copy. Deciding by it can only ever REFUSE more.
 */
export const PROJECT_PATH_HEADER = "x-softify-project-path";

/** Remembers the last project opened, ONLY so `/open` can continue there. Never decides reads or writes. */
export const LAST_PROJECT_COOKIE = "softify-last-project";

/**
 * Paths that are not inside a project: sign-in, the project chooser, the Main Admin Portal, health,
 * framework assets. A link to one of these is never prefixed with the current project.
 */
const OUTSIDE_PROJECT = [
  /^\/login(\/|$|\?)/,
  /^\/open(\/|$|\?)/,
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

/** `/rules` → `/p/isp-digital/rules`. Leaves external, relative, hash and outside-project URLs alone. */
export function projectHref(href: string, slug: string | null | undefined): string {
  if (!slug || !href.startsWith("/") || href.startsWith("//") || isOutsideProject(href)) return href;
  return `/p/${slug}${href === "/" ? "" : href}`;
}

/** `/p/isp-digital/rules/42` → `/rules/42`: what the navigation's active-state logic compares against. */
export function stripProjectPrefix(pathname: string): string {
  const match = SLUG_RE.exec(pathname);
  if (!match) return pathname;
  const rest = pathname.slice(match[0].length);
  return rest === "" ? "/" : rest;
}
