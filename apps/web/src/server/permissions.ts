import { projectPath } from "@/server/projectPaths";
import { prisma } from "@/server/db";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import {
  isPermissionKey,
  isProjectAssignableKey,
  levelAllows,
  resolveRoleKeys,
  type PermissionKey,
  type ProjectAccessLevelValue,
  type ProjectMembership,
  VENDOR_PERMISSION_KEYS,
} from "@support-automation/shared";
import { activeProjectSlug, requireActiveProject } from "@/server/projectContext";
import { getSession, type Session } from "@/server/auth";
import { logSystemEvent } from "@/server/logSystemEvent";
import { PROJECT_PATH_HEADER } from "@/lib/projectPaths";
import {
  canOpenPath,
  isSectionReadKey,
  pathPermitsKey,
  sanitizeSectionAccess,
  sectionsPermitKey,
  type SectionAccess,
} from "@/app/p/[project]/(dashboard)/projectSections";

/**
 * What a check may say about the page side of a project role (PROJECT_ROLES.md §"Pages"). An action
 * that changes something one page owns names that page, so a member cannot reach it from a sibling
 * page that happens to share its key (the four WhatsApp pages all use `whatsapp.manage`).
 */
export interface PageGate {
  /** The section ids (page paths) this action belongs to; any of them, at the needed level, will do. */
  sections?: readonly string[];
}

/**
 * Deliberately a second call, never merged into requireSession() — requireSession() is called on
 * ~90 existing pages that have no concept of permissions at all and must not pay for this join;
 * only the new Users/Permission-Modules/Security-Settings pages call both:
 *   const session = await requireSession();
 *   await requirePermission(session, "users.view");
 *
 * Fails closed on every case: unknown/mistyped key, no permission module assigned, inactive user
 * (defense-in-depth — getSession() already rejects inactive users, but this never trusts that
 * alone), and any DB error resolving the permission set is left to throw rather than defaulting
 * to "allow."
 */
export async function requirePermission(session: Session, key: PermissionKey, gate?: PageGate): Promise<void> {
  if (!isPermissionKey(key)) {
    await logSystemEvent("WARN", "permissions", "PERMISSION_DENIED_UNKNOWN_KEY", { userId: session.userId, key });
    redirect(await projectPath("/overview"));
  }

  const access = await accessForRequest(session);
  if (access === null) {
    await logSystemEvent("WARN", "permissions", "PERMISSION_DENIED_INACTIVE_USER", { userId: session.userId, key });
    redirect(await projectPath("/login"));
  }

  if (!access.keys.has(key)) {
    await logSystemEvent("WARN", "permissions", "PERMISSION_DENIED", { userId: session.userId, key });
    // Carries the key so the Overview can say what was refused. A bare redirect dropped somebody on
    // the dashboard with no idea why their click went nowhere — which reads as a broken button.
    redirect(await projectPath(`/overview?denied=${encodeURIComponent(key)}`));
  }
  const level = await levelInThisProject();
  if (!levelAllows(level, key)) {
    await logSystemEvent("WARN", "permissions", "PERMISSION_DENIED_ACCESS_LEVEL", { userId: session.userId, key, level });
    redirect(await projectPath(`/overview?denied=${encodeURIComponent(key)}&level=${level}`));
  }
  if (access.pages && !(await pagesPermit(access.pages, key, gate))) {
    const path = await requestPath();
    await logSystemEvent("WARN", "permissions", "PERMISSION_DENIED_PAGE", { userId: session.userId, key, path, sections: gate?.sections ?? null });
    redirect(await projectPath(`/overview?page=${encodeURIComponent(gate?.sections?.[0] ?? path ?? "")}`));
  }
}

/**
 * The viewer's access level in the project this request is for (MAIN_ADMIN_WORKSPACE.md §4), or null
 * outside a project (the Main Admin Portal), where no project's level applies. A level only narrows
 * the role; the project step itself is `requireActiveProject`, which every page and action already
 * runs, so a request the project refuses is refused there — this never widens anything.
 */
export async function levelInThisProject(): Promise<ProjectAccessLevelValue | null> {
  if (!(await activeProjectSlug())) return null;
  try {
    return (await requireActiveProject()).accessLevel ?? "FULL";
  } catch {
    return null;
  }
}

/**
 * Why a key is refused here, if it is: the role lacks it, the project's access level holds it back,
 * or the member's project role does not give the page it is used from (or the action's own page).
 */
export async function permissionRefusal(session: Session, key: PermissionKey, gate?: PageGate): Promise<"ROLE" | "LEVEL" | "PAGE" | null> {
  if (!isPermissionKey(key)) return "ROLE";
  const access = await accessForRequest(session);
  if (!access || !access.keys.has(key)) return "ROLE";
  if (!levelAllows(await levelInThisProject(), key)) return "LEVEL";
  if (access.pages && !(await pagesPermit(access.pages, key, gate))) return "PAGE";
  return null;
}

/**
 * Same checks as requirePermission(), but returns a boolean instead of redirecting — for Server
 * Actions, which must return a typed {error: "..."} form state rather than throwing a
 * navigation-only redirect() into a form submission.
 */
export async function hasPermission(session: Session, key: PermissionKey, gate?: PageGate): Promise<boolean> {
  return (await permissionRefusal(session, key, gate)) === null;
}

/** The path inside the project this request is for — the page, or the page a Server Action was posted from. */
async function requestPath(): Promise<string | null> {
  try {
    return (await headers()).get(PROJECT_PATH_HEADER);
  } catch {
    return null;
  }
}

/**
 * The page side of a project role, for one key in this request: the page it is used from must be
 * granted (at Full to change anything), and so must the action's own pages when it names them.
 *
 * A request with no page (an OAuth callback, work in `after()`) can only read — unless the action names
 * its own pages, which then decide alone. Writing always needs a page somebody granted.
 */
async function pagesPermit(pages: SectionAccess, key: string, gate?: PageGate): Promise<boolean> {
  if (gate?.sections && !sectionsPermitKey(gate.sections, pages, key)) return false;
  const path = await requestPath();
  if (path === null) return gate?.sections !== undefined || !isProjectAssignableKey(key) || isSectionReadKey(key);
  return pathPermitsKey(path, pages, key);
}

/**
 * The operator's kill switch for project-level roles (PROJECT_ROLES.md). Set, every user is governed
 * by their global role again — exactly the behaviour before project roles existed. Nothing is deleted:
 * the project roles and Leads stay stored and apply again when it is unset.
 */
export function projectRolesDisabled(): boolean {
  return process.env.PROJECT_ROLES_DISABLED === "true";
}

/**
 * The narrower switch: project roles keep their keys, but no page selection is applied — the sidebar
 * and the pages behave as before page-level roles existed. For a page found to be mapped wrongly.
 */
export function projectRolePagesDisabled(): boolean {
  return process.env.PROJECT_ROLE_PAGES_DISABLED === "true";
}

/**
 * What the user holds in this request, before the level and the project's features narrow it: their
 * global role, with their project-level role in THIS project applied (`resolveRoleKeys`), and — when
 * that role selects pages — which pages it opens. Null for an inactive or missing user. The ONE place
 * a role becomes keys and pages: requirePermission, hasPermission, permissionRefusal,
 * getGrantedPermissionKeys, getPageAccess and blockedPagePath all ask here, so they cannot disagree.
 *
 * `pages` is null for everybody a page selection does not apply to — a global role with no project
 * role, a Lead, a Main Admin, a role saved before pages existed — whose keys decide exactly as before.
 */
async function accessForRequest(session: Session): Promise<{ keys: Set<string>; pages: SectionAccess | null } | null> {
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: {
      isActive: true,
      permissionModule: { select: { permissions: { select: { permission: { select: { key: true } } } } } },
    },
  });
  if (!user || !user.isActive) return null;
  // A customer's own Main Admin keeps every key on that customer's address (SAAS_PLATFORM_PLAN.md §12);
  // what any key can reach is confined to the person's customer by the data layer (server/db.ts). The
  // only keys a customer never holds are the product's own (VENDOR_PERMISSION_KEYS): they work only
  // for the original installation's people.
  const vendorOnly = (session.tenant ?? null) === null ? null : new Set(VENDOR_PERMISSION_KEYS);
  const globalKeys = (user.permissionModule?.permissions.map((p) => p.permission.key) ?? []).filter((key) => !vendorOnly?.has(key));
  if (projectRolesDisabled()) return { keys: new Set(globalKeys), pages: null };
  const membership = await membershipInThisProject(session.userId);
  const keys = resolveRoleKeys(globalKeys, membership);
  const pagesApply =
    membership !== null &&
    !membership.isLead &&
    membership.projectRoleKeys !== null &&
    membership.sectionAccess !== null &&
    // A Main Admin is governed by their global role everywhere (resolveRoleKeys says the same).
    !globalKeys.includes("projects.manage") &&
    !projectRolePagesDisabled();
  return { keys, pages: pagesApply ? membership.sectionAccess : null };
}

/**
 * The user's project-level role in the project this request is for, or null — outside a project, in a
 * project they may not enter, or with no ProjectMemberRole row (every user before project roles).
 * Null always means "the global role applies", which is how every check behaved before; for a user
 * created inside a project (no global role) it means nothing at all, so a failure here fails closed.
 */
async function membershipInThisProject(userId: string): Promise<(ProjectMembership & { sectionAccess: SectionAccess | null }) | null> {
  if (!(await activeProjectSlug())) return null;
  let projectId: string;
  try {
    projectId = (await requireActiveProject()).id;
  } catch {
    return null;
  }
  const row = await prisma.projectMemberRole.findFirst({
    where: { projectId, userId },
    select: { isLead: true, projectRoleId: true, projectRole: { select: { projectId: true, permissionKeys: true, sectionAccess: true } } },
  });
  if (!row) return null;
  if (!row.projectRoleId) return { isLead: row.isLead, projectRoleKeys: null, sectionAccess: null };
  // A role of another project cannot be attached (a database trigger refuses it); if it ever were,
  // it would mean nothing here rather than something — no keys and no pages.
  const ownRole = row.projectRole && row.projectRole.projectId === projectId ? row.projectRole : null;
  if (!ownRole) return { isLead: row.isLead, projectRoleKeys: [], sectionAccess: {} };
  // Read through the same filter as every write: an unknown page or level in the stored value is ignored.
  const sectionAccess = ownRole.sectionAccess === null ? null : sanitizeSectionAccess(ownRole.sectionAccess);
  return { isLead: row.isLead, projectRoleKeys: ownRole.permissionKeys, sectionAccess };
}

/**
 * Whether ANOTHER user's role (in this project, project role applied) holds a key — for deciding who
 * may be offered or notified (inbox @mentions), never for authorising the current request. Access
 * levels only ever narrow write keys, so a read key answered here is not widened by them.
 */
export async function userHoldsKey(userId: string, tenant: string | null | undefined, key: PermissionKey): Promise<boolean> {
  const access = await accessForRequest({ userId, tenant: tenant ?? null } as Session);
  return Boolean(access?.keys.has(key));
}

/**
 * Every permission key this user's role grants — for PRESENTATION only (which sidebar links and
 * assistant to show). Never a substitute for `requirePermission`/`hasPermission` at the point of
 * use: a hidden link is not a check, and every page and action makes its own. Answers an empty
 * set for an inactive or missing user, which hides everything rather than guessing.
 */
export async function getGrantedPermissionKeys(session: Session): Promise<string[]> {
  const access = await accessForRequest(session);
  if (!access) return [];
  // What the shell offers follows the project's access level too, so a Read user is not shown
  // buttons for things the level will refuse. Presentation only — every action still checks.
  const level = await levelInThisProject();
  return [...access.keys].filter((key) => levelAllows(level, key));
}

/**
 * The pages this user's project role opens here, or null when no page selection applies (see
 * accessForRequest). For PRESENTATION — the sidebar, the Overview — like getGrantedPermissionKeys.
 */
export async function getPageAccess(session: Session): Promise<SectionAccess | null> {
  return (await accessForRequest(session))?.pages ?? null;
}

/**
 * The page step for a page request: the path this request is for, when the user's project role does
 * not open it; otherwise null. Run by `requireProjectPage`, so it covers every page, including the
 * ones that check no key (the reports hub, redirects). The page still checks its own keys.
 */
export async function blockedPagePath(): Promise<string | null> {
  const path = await requestPath();
  if (path === null) return null;
  const session = await getSession();
  if (!session) return null;
  const pages = await getPageAccess(session);
  return pages && !canOpenPath(path, pages) ? path : null;
}
