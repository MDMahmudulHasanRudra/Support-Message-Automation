import type { PermissionKey, ProjectFeatureKey } from "@support-automation/shared";

/**
 * The Main Admin Workspace (MAIN_ADMIN_WORKSPACE.md): an EXISTING project module opened from the
 * Main Admin Portal, with the projects the viewer may use it in as tabs.
 *
 *     /admin/workspace/whatsapp-chat/isp-digital/<groupId>
 *                      └── module ──┘└─ project ┘└─ the module's own path ─┘
 *
 * A workspace page IS the project's page: proxy.ts reads the project from this URL exactly as it
 * reads `/p/<slug>/…` — the same headers, overwritten the same way — so every existing check (may
 * this user enter the project, is the feature enabled, the existing permission, read-only status)
 * and the scoped database client run unchanged. Nothing here adds a way in; it only adds a second
 * URL shape that leads to the same checks.
 *
 * The project is a PATH segment, not `?project=`, on purpose: a Server Action posts to the page's
 * path, and the project has to travel with it the way it does in `/p/<slug>/…`.
 *
 * Pure and shared by proxy.ts, the client link wrappers and the server helpers.
 */

export const WORKSPACE_BASE = "/admin/workspace";

export interface WorkspaceModuleDefinition {
  /** The URL segment after /admin/workspace/. */
  key: string;
  label: string;
  /** The module's pages inside a project ("/chat" covers "/chat", "/chat/<id>", "/chat/archived"). */
  projectPath: string;
  /** The project feature the module belongs to: a project with it switched off gets no tab. */
  feature: ProjectFeatureKey;
  /** The existing permission that opens the module. Checked again by the module's own pages. */
  permission: PermissionKey;
  description: string;
}

/**
 * The modules the workspace can open. Adding one is: an entry here, and a route folder under
 * `app/admin/workspace/<key>/[project]/` whose files re-export the module's existing pages.
 */
export const WORKSPACE_MODULES = [
  {
    key: "whatsapp-chat",
    label: "WhatsApp Chat",
    projectPath: "/chat",
    feature: "WHATSAPP_CHAT",
    permission: "messages.view",
    description: "The WhatsApp inbox of each project you can use it in, one project per tab.",
  },
] as const satisfies readonly WorkspaceModuleDefinition[];

export type WorkspaceModuleKey = (typeof WORKSPACE_MODULES)[number]["key"];

export function workspaceModule(key: string): WorkspaceModuleDefinition | null {
  return WORKSPACE_MODULES.find((m) => m.key === key) ?? null;
}

/**
 * Remembers the project last opened in the workspace, ONLY so `/admin/workspace/<module>` can open
 * the same tab again. Never decides reads or writes — the URL does — and a project that is no longer
 * one of the viewer's tabs is ignored.
 */
export const WORKSPACE_PROJECT_COOKIE = "softify-workspace-project";

/** Same shape as a project slug in lib/projectPaths.ts. */
const WORKSPACE_RE = /^\/admin\/workspace\/([a-z0-9-]+)\/([a-z0-9][a-z0-9-]{0,62})(\/[^?#]*)?(?:[?#].*)?$/;

export interface WorkspaceLocation {
  module: WorkspaceModuleDefinition;
  slug: string;
  /** The path inside the project this workspace URL shows ("/chat/abc"). */
  projectPath: string;
}

/** `/admin/workspace/whatsapp-chat/isp-digital/abc` → WhatsApp Chat, isp-digital, "/chat/abc". Unknown module → null. */
export function parseWorkspacePath(path: string): WorkspaceLocation | null {
  const match = WORKSPACE_RE.exec(path);
  if (!match) return null;
  const mod = workspaceModule(match[1]!);
  if (!mod) return null;
  const rest = match[3] && match[3] !== "/" ? match[3].replace(/\/$/, "") : "";
  return { module: mod, slug: match[2]!, projectPath: `${mod.projectPath}${rest}` };
}

/** The workspace URL of one module in one project. */
export function workspacePath(moduleKey: string, slug: string): string {
  return `${WORKSPACE_BASE}/${moduleKey}/${slug}`;
}

/**
 * A project-relative href ("/chat/abc") rendered inside a workspace module. The module's own pages
 * stay in the workspace; anything else ("/groups") opens in the project portal of the SAME project.
 * Either way the href can only point into the project it was rendered in.
 */
export function workspaceHref(href: string, slug: string, moduleKey: string): string | null {
  const mod = workspaceModule(moduleKey);
  if (!mod || !href.startsWith("/") || href.startsWith("//")) return null;
  const base = mod.projectPath;
  if (href === base || href.startsWith(`${base}/`) || href.startsWith(`${base}?`) || href.startsWith(`${base}#`)) {
    return `${workspacePath(mod.key, slug)}${href.slice(base.length)}`;
  }
  return null;
}
