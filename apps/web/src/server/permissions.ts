import { redirect } from "next/navigation";
import { prisma } from "@support-automation/db";
import { isPermissionKey, type PermissionKey } from "@support-automation/shared";
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
    redirect("/overview");
  }

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: {
      isActive: true,
      permissionModule: {
        select: { permissions: { select: { permission: { select: { key: true } } } } },
      },
    },
  });

  if (!user || !user.isActive) {
    await logSystemEvent("WARN", "permissions", "PERMISSION_DENIED_INACTIVE_USER", { userId: session.userId, key });
    redirect("/login");
  }

  const grantedKeys = new Set(user.permissionModule?.permissions.map((p) => p.permission.key) ?? []);
  if (!grantedKeys.has(key)) {
    await logSystemEvent("WARN", "permissions", "PERMISSION_DENIED", { userId: session.userId, key });
    redirect("/overview");
  }
}

/**
 * Same checks as requirePermission(), but returns a boolean instead of redirecting — for Server
 * Actions, which must return a typed {error: "..."} form state rather than throwing a
 * navigation-only redirect() into a form submission.
 */
export async function hasPermission(session: Session, key: PermissionKey): Promise<boolean> {
  if (!isPermissionKey(key)) return false;

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: {
      isActive: true,
      permissionModule: {
        select: { permissions: { select: { permission: { select: { key: true } } } } },
      },
    },
  });
  if (!user || !user.isActive) return false;

  const grantedKeys = new Set(user.permissionModule?.permissions.map((p) => p.permission.key) ?? []);
  return grantedKeys.has(key);
}
