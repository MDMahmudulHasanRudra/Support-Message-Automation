import { featureForPath, type ProjectFeatureKey, type ProjectStatusValue } from "@support-automation/shared";

/**
 * The Main Admin Workspace (MAIN_ADMIN_WORKSPACE.md): EVERY project module, opened from the Main
 * Admin Portal, with the projects the viewer may use it in as tabs.
 *
 *     /admin/workspace/<project-slug>/<any project page>
 *     /admin/workspace/isp-digital/chat/<groupId>   renders   /p/isp-digital/chat/<groupId>
 *
 * A workspace URL IS the project page: proxy.ts rewrites it to `/p/<slug>/…` and sets the same
 * project headers, from the same URL segment, overwriting any the client sent. So the page that
 * renders is the portal's own page — nothing is copied per module or per project — and every
 * existing check (may this user enter the project, is the feature enabled, the existing
 * permission, read-only status) and the scoped database client run unchanged. The dashboard layout
 * only swaps the portal's chrome for the Main Admin chrome and draws the project tabs.
 *
 * The project is a PATH segment, not `?project=`, on purpose: a Server Action posts to the page's
 * path, and the project has to travel with it exactly as it does in `/p/<slug>/…`. Putting the
 * project first also makes the selected project persist across modules: every link on a workspace
 * page is written in the same project.
 *
 * Pure and shared by proxy.ts, the client link wrappers, the shell and the server helpers.
 */

export const WORKSPACE_BASE = "/admin/workspace";

/**
 * Remembers the project last opened in the workspace, ONLY so a module opened from the Main Admin
 * sidebar starts on the same tab. Never decides a read or a write — the URL does — and a project that
 * is no longer one of the viewer's projects is ignored wherever it is read.
 */
export const WORKSPACE_PROJECT_COOKIE = "softify-workspace-project";

/**
 * proxy.ts rewrites a workspace URL to `/p/<slug>~ws/…` rather than `/p/<slug>/…`. The page tree is
 * the same; the `[project]` segment VALUE differs, and that is the point: the router keeps a layout
 * across a navigation only while its segments are unchanged, so without the marker a click from the
 * workspace to the same page in the portal (or back) kept the other mode's chrome. The value is
 * never authority — the project always comes from the header proxy.ts sets — and `/p/<slug>~ws/…`
 * requested directly carries no project at all (it is not a slug), so it is a 404.
 */
export const WORKSPACE_SEGMENT_MARKER = "~ws";

/** The `[project]` route segment as a slug, and whether it is the workspace's. */
export function readProjectSegment(value: string): { slug: string; workspace: boolean } {
  const decoded = value.replace(/%7e/gi, "~");
  return decoded.endsWith(WORKSPACE_SEGMENT_MARKER)
    ? { slug: decoded.slice(0, -WORKSPACE_SEGMENT_MARKER.length), workspace: true }
    : { slug: decoded, workspace: false };
}

/** Same shape as a project slug in lib/projectPaths.ts. */
const WORKSPACE_RE = /^\/admin\/workspace\/([a-z0-9][a-z0-9-]{0,62})(\/[^?#]*)?(?:[?#].*)?$/;

export interface WorkspaceLocation {
  slug: string;
  /** The page inside the project this workspace URL shows ("/chat/abc"; "/" for the project root). */
  projectPath: string;
}

/** `/admin/workspace/isp-digital/chat/abc` → isp-digital, "/chat/abc". Anything else → null. */
export function parseWorkspacePath(path: string): WorkspaceLocation | null {
  const match = WORKSPACE_RE.exec(path);
  if (!match) return null;
  const rest = match[2] && match[2] !== "/" ? match[2].replace(/\/$/, "") : "/";
  return { slug: match[1]!, projectPath: rest };
}

/** A project-relative href ("/chat/abc?x=1") as a workspace URL in one project. */
export function workspaceHref(href: string, slug: string): string {
  return `${WORKSPACE_BASE}/${slug}${href === "/" ? "" : href}`;
}

/**
 * Opens a project page in the workspace, choosing the project on the server: the remembered one if
 * the viewer may still use this page there, otherwise the first that can. What the Main Admin
 * sidebar links to, and what a workspace sidebar link points at when the CURRENT project does not
 * have that module.
 */
export function workspaceOpenHref(projectRelativeHref: string): string {
  return `${WORKSPACE_BASE}?to=${encodeURIComponent(projectRelativeHref)}`;
}

/** A `to=` value is only ever a project-relative page: never another origin, never outside a project. */
export function safeWorkspaceTarget(to: string | null | undefined): string {
  if (!to || !to.startsWith("/") || to.startsWith("//") || to.startsWith("/admin") || to.startsWith("/p/") || to.includes("\\")) {
    return "/overview";
  }
  return to;
}

/**
 * Pages whose data is NOT a project's: logins, roles, the sign-in policy and the product's release
 * notes are one set for the whole installation (User, PermissionModule, SecuritySettings and
 * ReleaseNote carry no projectId). They open in the workspace like any page — the existing page,
 * the existing checks — but without project tabs, because every tab would show the same thing.
 */
export const GLOBAL_PAGE_PREFIXES = ["/users", "/permissions", "/settings/security", "/release-notes"] as const;

export function isGlobalPage(projectPath: string): boolean {
  const path = projectPath.split(/[?#]/)[0]!;
  return GLOBAL_PAGE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export interface WorkspaceProject {
  slug: string;
  name: string;
  status: ProjectStatusValue;
  /** Features switched off in this project — its tab is not offered on their pages. */
  disabledFeatures: ProjectFeatureKey[];
}

/**
 * The project tabs for one page — the SAME rule for every module. `projects` is already exactly the
 * projects the viewer may enter (server-computed); this only drops the ones where the page's feature
 * is switched off. A global page has no tabs. Presentation only: opening a tab still runs every
 * check in that project.
 */
export function workspaceTabsFor(projects: readonly WorkspaceProject[], projectPath: string): WorkspaceProject[] {
  if (isGlobalPage(projectPath)) return [];
  const feature = featureForPath(projectPath);
  return feature ? projects.filter((p) => !p.disabledFeatures.includes(feature)) : [...projects];
}

/** Features switched off in EVERY one of these projects — the only modules the workspace sidebar leaves out. */
export function featuresOffEverywhere(projects: readonly WorkspaceProject[]): ProjectFeatureKey[] {
  if (projects.length === 0) return [];
  return projects[0]!.disabledFeatures.filter((f) => projects.every((p) => p.disabledFeatures.includes(f)));
}
