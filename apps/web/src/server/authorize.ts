import { notFound } from "next/navigation";
import type { PermissionKey } from "@support-automation/shared";
import { requireSession, type Session } from "@/server/auth";
import { hasPermission, requirePermission } from "@/server/permissions";
import { ProjectAccessError, requireActiveProject, type ActiveProject } from "@/server/projectContext";
import { isReadOnlyProjectStatus } from "@support-automation/shared";

/**
 * Permission checks for pages and Server Actions, in the three shapes this app needs.
 *
 * Every Server Action is a public HTTP endpoint: anyone with a session can call it directly,
 * whether or not the page that normally shows its button is one they can open. So hiding a page is
 * not a permission check — the action has to make its own. Until these were used everywhere, the
 * roles assigned on Permission Modules governed five modules and nothing else.
 *
 * MULTI-PROJECT: every check here now runs in this order —
 *
 *     session → may this user enter the URL's project? → the existing permission check
 *
 * The middle step is new and separate (`ProjectAccess`, server/projectContext.ts); the permission
 * check after it is exactly the one that existed before, unchanged, and gives the same answer in
 * every project the user can enter. A user without access to the project is refused before any
 * permission is looked at. The database client enforces the same project independently
 * (server/db.ts), so a page that forgot to call one of these still cannot read another project.
 */

/** Refusal wording for a project the user cannot enter. Does not say whether it exists. */
export const PROJECT_ACCESS_DENIED_ERROR = "You do not have access to this project.";

/**
 * The project step, for pages: the active project, or a 404. A project the user cannot enter is
 * indistinguishable from one that does not exist — nothing about it is disclosed.
 */
export async function requireProjectPage(): Promise<ActiveProject> {
  try {
    return await requireActiveProject();
  } catch (err) {
    if (err instanceof ProjectAccessError) {
      if (err.reason === "NO_SESSION") await requireSession(); // → /login
      notFound();
    }
    throw err;
  }
}

export const PERMISSION_DENIED_ERROR = "You do not have permission to perform this action.";

/**
 * For an action that returns form state: the session, or the sentence to return. The existing
 * pattern in users.ts / sessions.ts, packaged so each action is two lines.
 *
 *     const access = await checkPermission("whatsapp.manage");
 *     if ("denied" in access) return { error: access.denied };
 */
export async function checkPermission(key: PermissionKey): Promise<{ session: Session } | { denied: string }> {
  const session = await requireSession();
  let project: ActiveProject;
  try {
    project = await requireActiveProject();
  } catch (err) {
    if (err instanceof ProjectAccessError) return { denied: PROJECT_ACCESS_DENIED_ERROR };
    throw err;
  }
  if (!(await hasPermission(session, key))) return { denied: PERMISSION_DENIED_ERROR };
  // A suspended or archived project is read-only (MULTI_PROJECT_PLAN.md §8). Refused here, with a
  // sentence the form can show, for every action gated on a key that changes something; the
  // database client refuses the write itself regardless (server/db.ts), this only words it.
  if (isReadOnlyProjectStatus(project.status) && !isReadKey(key)) return { denied: projectReadOnlyError(project) };
  return { session };
}

/** Keys that only read: `.view` and the export keys. Everything else changes something. */
function isReadKey(key: string): boolean {
  return key.endsWith(".view") || key.endsWith(".bulk_export");
}

export function projectReadOnlyError(project: ActiveProject): string {
  return project.status === "ARCHIVED"
    ? `${project.name} is archived and read-only, so nothing was changed.`
    : `${project.name} is suspended and read-only until a Main Admin makes it active again, so nothing was changed.`;
}

/**
 * For an action that returns nothing, and for a page: the session, or a redirect to the Overview
 * with a banner saying why.
 *
 * An action with no return value has nowhere to put a refusal. Throwing would replace the page with
 * the error boundary; returning silently would let the caller show a success toast for something
 * that did not happen. A redirect is neither, and it is what pages already do on a denial.
 */
export async function requireAccess(key: PermissionKey): Promise<Session> {
  const session = await requireSession();
  await requireProjectPage();
  await requirePermission(session, key);
  return session;
}

/**
 * For a module page: requires the view key, and reports whether this user may also change things —
 * so the page can say it is view-only rather than letting somebody find out one refused click at a
 * time.
 */
export async function pageAccess(viewKey: PermissionKey, manageKey: PermissionKey): Promise<{ session: Session; canManage: boolean }> {
  const session = await requireAccess(viewKey);
  return { session, canManage: await hasPermission(session, manageKey) };
}
