import type { PermissionKey } from "@support-automation/shared";
import { requireSession, type Session } from "@/server/auth";
import { hasPermission, requirePermission } from "@/server/permissions";

/**
 * Permission checks for pages and Server Actions, in the three shapes this app needs.
 *
 * Every Server Action is a public HTTP endpoint: anyone with a session can call it directly,
 * whether or not the page that normally shows its button is one they can open. So hiding a page is
 * not a permission check — the action has to make its own. Until these were used everywhere, the
 * roles assigned on Permission Modules governed five modules and nothing else.
 */

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
  return (await hasPermission(session, key)) ? { session } : { denied: PERMISSION_DENIED_ERROR };
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
