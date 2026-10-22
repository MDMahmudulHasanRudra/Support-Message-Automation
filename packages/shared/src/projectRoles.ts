import { ADMIN_GRANTED_KEYS, MAIN_ADMIN_CATEGORY, PERMISSIONS, PROJECT_ADMIN_CATEGORY, type PermissionDefinition } from "./permissions.js";

/**
 * Two-level permissions (PROJECT_ROLES.md): what a user may do INSIDE one project.
 *
 * The platform level is unchanged: a user's global role (`User.permissionModuleId`, a Permission
 * Module) still decides the Main Admin Portal, the platform-wide App Users / Permission Modules pages,
 * and — for everybody who has not been given anything new — what they may do in every project.
 *
 * The project level is new and only ever applies where somebody set it, on that user's
 * `ProjectAccess` row for that one project:
 *
 *   - `projectRoleId`: a project role (created inside the project, by its Lead or a Main Admin).
 *     In that project it REPLACES the project-scoped part of the global role. The platform-only part
 *     of the global role (Main Admin keys, App Users & Permission Modules, release-note editing) is
 *     kept: a project cannot hand those out and cannot take them away.
 *   - `isLead`: the project's Lead (only a Main Admin designates one). Every project-scoped key in
 *     that project, plus that project's administration (members and roles). Never a platform key.
 *
 * A row with neither — every row that existed before this — resolves to EXACTLY the global role,
 * byte for byte. That is the compatibility guarantee for the projects already running, and the
 * unit test proves it over every subset shape of the catalogue.
 */

/** Categories whose keys are the platform's, never a project's to grant. */
const PLATFORM_ONLY_CATEGORIES: ReadonlySet<string> = new Set([MAIN_ADMIN_CATEGORY, "Users & Permissions", PROJECT_ADMIN_CATEGORY]);
/** Single keys that are platform content although their category is not (release notes are one changelog for everybody). */
const PLATFORM_ONLY_KEYS: ReadonlySet<string> = new Set(["release_notes.manage", ...ADMIN_GRANTED_KEYS]);

const KNOWN: ReadonlyMap<string, PermissionDefinition> = new Map(PERMISSIONS.map((p) => [p.key, p]));

/** Whether a key may be put in a project role: a known key whose data belongs to one project. */
export function isProjectAssignableKey(key: string): boolean {
  const def = KNOWN.get(key);
  if (!def) return false;
  return !PLATFORM_ONLY_CATEGORIES.has(def.category) && !PLATFORM_ONLY_KEYS.has(key);
}

/** The catalogue a project role is built from, in catalogue order (grouped by category for the form). */
export const PROJECT_ASSIGNABLE_PERMISSIONS: readonly PermissionDefinition[] = PERMISSIONS.filter((p) => isProjectAssignableKey(p.key));

/** The project's own administration keys — a Lead's, in the project they lead. */
export const PROJECT_ADMIN_KEYS: readonly string[] = PERMISSIONS.filter((p) => p.category === PROJECT_ADMIN_CATEGORY).map((p) => p.key);

/** Everything a Lead holds in the project they lead. */
export const PROJECT_LEAD_KEYS: readonly string[] = [...PROJECT_ASSIGNABLE_PERMISSIONS.map((p) => p.key), ...PROJECT_ADMIN_KEYS];

/** Keeps only what a project role may hold, de-duplicated, in catalogue order. Unknown keys are dropped. */
export function sanitizeProjectRoleKeys(keys: Iterable<string>): string[] {
  const wanted = new Set(keys);
  return PROJECT_ASSIGNABLE_PERMISSIONS.filter((p) => wanted.has(p.key)).map((p) => p.key);
}

/** One user's membership of the project a request is for. Null outside a project (the portal). */
export interface ProjectMembership {
  isLead: boolean;
  /** The project role's keys, or null when no project role is set (the global role applies). */
  projectRoleKeys: readonly string[] | null;
}

/**
 * The keys a user holds in one request, before the access level and the project's features narrow
 * them (those two steps are unchanged and still applied by the callers).
 *
 *   platform part  = the global role's keys that are not project-assignable (kept everywhere)
 *   project part   = the project role's keys if one is set, else the global role's project keys
 *   lead part      = PROJECT_LEAD_KEYS when the user leads this project
 *
 * `disabled` is the operator's kill switch: the new fields are ignored and the global role is the
 * answer everywhere — exactly the behaviour before project roles existed.
 */
export function resolveRoleKeys(globalKeys: Iterable<string>, membership: ProjectMembership | null, disabled = false): Set<string> {
  const global = new Set(globalKeys);
  if (disabled || membership === null) return global;
  // A Main Admin is governed by their global role in every project; nothing set inside a project
  // can narrow or replace it (and only a Main Admin could have set it).
  if (global.has("projects.manage")) return global;
  if (!membership.isLead && membership.projectRoleKeys === null) return global; // every pre-existing row
  const result = new Set<string>();
  for (const key of global) if (!isProjectAssignableKey(key)) result.add(key);
  const projectSource = membership.projectRoleKeys ?? [...global];
  for (const key of projectSource) if (isProjectAssignableKey(key)) result.add(key);
  if (membership.isLead) for (const key of PROJECT_LEAD_KEYS) result.add(key);
  return result;
}

/** What one person may do to one member of the project they are administering. */
export interface ProjectMemberActions {
  /** Choose the member's project role. */
  changeRole: boolean;
  /** Take away their access to this project. */
  remove: boolean;
  /** Set a new password (signs them out everywhere). */
  resetPassword: boolean;
  /** Deactivate or reactivate the login. */
  setActive: boolean;
}

/**
 * The project-administration rules (PROJECT_ROLES.md), pure so they are tested once and applied by
 * both the page (which buttons to show) and every Server Action (which requests to refuse):
 *
 *   - nobody manages themselves here (a Lead cannot raise or remove their own membership);
 *   - only a Main Admin manages a Lead, or anybody whose global role is privileged (a Main Admin key
 *     or the project-administration keys);
 *   - a Lead changes a member's role in, and access to, THEIR project — nothing outside it;
 *   - a login is shared across projects, so changing the login itself (password, active) is only a
 *     Lead's to do when the person exists for this project alone: no other project, no global role.
 */
export function projectMemberActions(facts: {
  actorIsMainAdmin: boolean;
  isSelf: boolean;
  targetIsPrivileged: boolean;
  targetIsLead: boolean;
  /** Member of no other project and no global role: the login belongs to this project only. */
  targetIsProjectOnly: boolean;
}): ProjectMemberActions {
  const none = { changeRole: false, remove: false, resetPassword: false, setActive: false };
  if (facts.isSelf) return none;
  if (!facts.actorIsMainAdmin && (facts.targetIsPrivileged || facts.targetIsLead)) return none;
  const ownsLogin = facts.actorIsMainAdmin || facts.targetIsProjectOnly;
  return { changeRole: true, remove: true, resetPassword: ownsLogin, setActive: ownsLogin };
}
