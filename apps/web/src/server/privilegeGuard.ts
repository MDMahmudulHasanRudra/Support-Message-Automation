import { MAIN_ADMIN_CATEGORY, PERMISSIONS } from "@support-automation/shared";
import { platformPrisma } from "@/server/db";
import { isMainAdmin } from "@/server/projectContext";

/**
 * Nobody becomes a Main Admin, or takes over one, except by another Main Admin's hand.
 *
 * Being a Main Admin is a property of a ROLE (it holds `projects.manage`, which enters every project).
 * Before this, `users.edit` let its holder put anyone — themselves included — on the Administrator
 * role; `users.create` created a login on it; `permissions.edit` added Main Admin keys to their own
 * role; and resetting a Main Admin's password took the account over. None of those keys mentions
 * projects, so the platform's widest power was reachable from a custom role nobody meant to make
 * powerful. The default roles are unaffected: only Administrator holds those keys, and Administrator
 * is a Main Admin.
 *
 * A change counts as privileged when it gives a role, or a person, any Main Admin key (the whole
 * Main Admin category — `projects.*` and `configuration.*`), or changes the role, password or active
 * state of a person who holds one. Privileged changes need the ACTOR to be a Main Admin. Nothing
 * else changes: every action still checks its own existing key first.
 */

export const PRIVILEGED_KEYS: readonly string[] = PERMISSIONS.filter((p) => p.category === MAIN_ADMIN_CATEGORY).map((p) => p.key);

export const MAIN_ADMIN_ONLY_ERROR =
  "Only a Main Admin can do this: it would give, or change, access to the Main Admin Portal and every project.";

/** Whether a role holds any Main Admin key. A missing or null role holds none. */
export async function roleIsPrivileged(permissionModuleId: string | null | undefined): Promise<boolean> {
  if (!permissionModuleId) return false;
  const hit = await platformPrisma.permissionModulePermission.findFirst({
    where: { permissionModuleId, permission: { key: { in: [...PRIVILEGED_KEYS] } } },
    select: { permissionId: true },
  });
  return hit !== null;
}

/** Whether a person's current role holds any Main Admin key. */
export async function userIsPrivileged(userId: string): Promise<boolean> {
  const user = await platformPrisma.user.findUnique({ where: { id: userId }, select: { permissionModuleId: true } });
  return roleIsPrivileged(user?.permissionModuleId);
}

/**
 * The refusal for a change, or null when it may go ahead. Pass what the change touches; any one of
 * them being privileged makes the whole change need a Main Admin.
 */
export async function privilegeRefusal(
  actorUserId: string,
  touches: {
    /** A role being given to somebody. */
    assignsRoleId?: string | null;
    /** A person whose role, password or active state is changing. */
    targetUserId?: string;
    /** A role whose permissions are being edited (privileged now = changing it is privileged). */
    editsRoleId?: string;
    /** The keys a role will hold after the change. */
    grantsKeys?: readonly string[];
  },
): Promise<string | null> {
  const privileged =
    (touches.grantsKeys?.some((k) => PRIVILEGED_KEYS.includes(k)) ?? false) ||
    (touches.assignsRoleId ? await roleIsPrivileged(touches.assignsRoleId) : false) ||
    (touches.editsRoleId ? await roleIsPrivileged(touches.editsRoleId) : false) ||
    (touches.targetUserId ? await userIsPrivileged(touches.targetUserId) : false);
  if (!privileged) return null;
  return (await isMainAdmin(actorUserId)) ? null : MAIN_ADMIN_ONLY_ERROR;
}
