import { projectPath } from "@/server/projectPaths";
import { prisma } from "@/server/db";
import { redirect } from "next/navigation";

import {
  isPermissionKey,
  levelAllows,
  resolveRoleKeys,
  type PermissionKey,
  type ProjectAccessLevelValue,
  type ProjectMembership,
} from "@support-automation/shared";
import { activeProjectSlug, requireActiveProject } from "@/server/projectContext";
import type { Session } from "@/server/auth";
import { logSystemEvent } from "@/server/logSystemEvent";

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
export async function requirePermission(session: Session, key: PermissionKey): Promise<void> {
  if (!isPermissionKey(key)) {
    await logSystemEvent("WARN", "permissions", "PERMISSION_DENIED_UNKNOWN_KEY", { userId: session.userId, key });
    redirect(await projectPath("/overview"));
  }

  const grantedKeys = await roleKeysForRequest(session);
  if (grantedKeys === null) {
    await logSystemEvent("WARN", "permissions", "PERMISSION_DENIED_INACTIVE_USER", { userId: session.userId, key });
    redirect(await projectPath("/login"));
  }

  if (!grantedKeys.has(key)) {
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

/** Why a key is refused here, if it is: the role lacks it, or the project's access level holds it back. */
export async function permissionRefusal(session: Session, key: PermissionKey): Promise<"ROLE" | "LEVEL" | null> {
  if (!(await roleGrants(session, key))) return "ROLE";
  return levelAllows(await levelInThisProject(), key) ? null : "LEVEL";
}

/**
 * Same checks as requirePermission(), but returns a boolean instead of redirecting — for Server
 * Actions, which must return a typed {error: "..."} form state rather than throwing a
 * navigation-only redirect() into a form submission.
 */
export async function hasPermission(session: Session, key: PermissionKey): Promise<boolean> {
  return (await permissionRefusal(session, key)) === null;
}

/** The role alone — the existing permission system, unchanged. Levels are applied on top by the callers above. */
async function roleGrants(session: Session, key: PermissionKey): Promise<boolean> {
  if (!isPermissionKey(key)) return false;
  const grantedKeys = await roleKeysForRequest(session);
  return grantedKeys !== null && grantedKeys.has(key);
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
 * What the user holds in this request, before the level and the project's features narrow it: their
 * global role, with their project-level role in THIS project applied (`resolveRoleKeys`). Null for an
 * inactive or missing user. The ONE place a role becomes a set of keys — requirePermission,
 * hasPermission, permissionRefusal and getGrantedPermissionKeys all ask here, so they cannot disagree.
 */
async function roleKeysForRequest(session: Session): Promise<Set<string> | null> {
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: {
      isActive: true,
      permissionModule: { select: { permissions: { select: { permission: { select: { key: true } } } } } },
    },
  });
  if (!user || !user.isActive) return null;
  const globalKeys = user.permissionModule?.permissions.map((p) => p.permission.key) ?? [];
  if (projectRolesDisabled()) return new Set(globalKeys);
  return resolveRoleKeys(globalKeys, await membershipInThisProject(session.userId));
}

/**
 * The user's project-level role in the project this request is for, or null — outside a project, in a
 * project they may not enter, or with no ProjectMemberRole row (every user before project roles).
 * Null always means "the global role applies", which is how every check behaved before; for a user
 * created inside a project (no global role) it means nothing at all, so a failure here fails closed.
 */
async function membershipInThisProject(userId: string): Promise<ProjectMembership | null> {
  if (!(await activeProjectSlug())) return null;
  let projectId: string;
  try {
    projectId = (await requireActiveProject()).id;
  } catch {
    return null;
  }
  const row = await prisma.projectMemberRole.findFirst({
    where: { projectId, userId },
    select: { isLead: true, projectRoleId: true, projectRole: { select: { projectId: true, permissionKeys: true } } },
  });
  if (!row) return null;
  if (!row.projectRoleId) return { isLead: row.isLead, projectRoleKeys: null };
  // A role of another project cannot be attached (a database trigger refuses it); if it ever were,
  // it would mean nothing here rather than something.
  const keys = row.projectRole && row.projectRole.projectId === projectId ? row.projectRole.permissionKeys : [];
  return { isLead: row.isLead, projectRoleKeys: keys };
}

/**
 * Every permission key this user's role grants — for PRESENTATION only (which sidebar links and
 * assistant to show). Never a substitute for `requirePermission`/`hasPermission` at the point of
 * use: a hidden link is not a check, and every page and action makes its own. Answers an empty
 * set for an inactive or missing user, which hides everything rather than guessing.
 */
export async function getGrantedPermissionKeys(session: Session): Promise<string[]> {
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: {
      isActive: true,
      permissionModule: { select: { permissions: { select: { permission: { select: { key: true } } } } } },
    },
  });
  if (!user || !user.isActive) return [];
  const globalKeys = user.permissionModule?.permissions.map((p) => p.permission.key) ?? [];
  const keys = projectRolesDisabled() ? globalKeys : [...resolveRoleKeys(globalKeys, await membershipInThisProject(session.userId))];
  // What the shell offers follows the project's access level too, so a Read user is not shown
  // buttons for things the level will refuse. Presentation only — every action still checks.
  const level = await levelInThisProject();
  return keys.filter((key) => levelAllows(level, key));
}
