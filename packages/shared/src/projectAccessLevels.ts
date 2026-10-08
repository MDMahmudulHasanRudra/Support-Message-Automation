import { MAIN_ADMIN_CATEGORY, PERMISSIONS } from "./permissions.js";

/**
 * Project access levels (MAIN_ADMIN_WORKSPACE.md §4): how much of their EXISTING role a user may use
 * inside one project. A level only ever takes rights away — the rule everywhere is
 *
 *     may do X in project P  =  role grants X  AND  level(P) allows X
 *
 * so the most restrictive of the two wins, FULL is exactly the role (never more), and no level can
 * grant a key the role does not hold. `ProjectAccess.level` null means FULL, which is what every row
 * written before levels existed has — nobody's rights changed when they were introduced.
 *
 *   READ   the role's read keys only: `.view` and `.bulk_export` (the same split authorize.ts already
 *          makes for a suspended project).
 *   WRITE  day-to-day work too — replying, editing rules and groups, running broadcasts — but not
 *          the role's `.delete` keys (today only "Delete Automation Rules") and not the project's
 *          automation or AI settings. Removals that the role's `.manage` keys cover (an account, a
 *          team member, a support rule) stay allowed, as they always were under that key: the level
 *          narrows by KEY, never by inspecting what an action does. The description below says so
 *          (audit MEDIUM #3 — it used to promise "not delete anything", which the rule never did).
 *   FULL   the whole role.
 *
 * Keys whose data belongs to no project — users, roles, the sign-in policy, release notes and the
 * Main Admin Portal's own keys — are not affected: a level describes one project, and those are the
 * same in every project.
 */

export const PROJECT_ACCESS_LEVELS = ["READ", "WRITE", "FULL"] as const;
export type ProjectAccessLevelValue = (typeof PROJECT_ACCESS_LEVELS)[number];

export function isProjectAccessLevel(value: unknown): value is ProjectAccessLevelValue {
  return typeof value === "string" && (PROJECT_ACCESS_LEVELS as readonly string[]).includes(value);
}

export const PROJECT_ACCESS_LEVEL_LABELS: Record<ProjectAccessLevelValue, string> = {
  READ: "Read",
  WRITE: "Write",
  FULL: "Full",
};

export const PROJECT_ACCESS_LEVEL_DESCRIPTIONS: Record<ProjectAccessLevelValue, string> = {
  READ: "Can look at everything their role allows, and change nothing.",
  WRITE:
    "Can do their role's day-to-day work, including what its manage permissions cover. Its delete permissions (such as deleting automation rules) and the project's automation and AI settings need Full.",
  FULL: "Can use everything their role allows. Never more than the role.",
};

/** Categories whose keys describe no project, so a project's level does not apply to them. */
const LEVEL_EXEMPT_CATEGORIES = new Set(["Users & Permissions", "Release Notes", MAIN_ADMIN_CATEGORY]);

const CATEGORY_BY_KEY = new Map(PERMISSIONS.map((p) => [p.key, p.category]));

/** Changing the project's own configuration: FULL only. Deleting anything is FULL only too. */
const FULL_ONLY_KEYS = new Set(["settings.edit", "ai_settings.edit"]);

export function isReadOnlyKey(key: string): boolean {
  return key.endsWith(".view") || key.endsWith(".bulk_export");
}

/** Whether a level lets a user use this key of their role. Unknown keys are refused under a limited level. */
export function levelAllows(level: ProjectAccessLevelValue | null | undefined, key: string): boolean {
  const effective = level ?? "FULL";
  if (effective === "FULL") return true;
  const category = CATEGORY_BY_KEY.get(key);
  if (category === undefined) return false;
  if (LEVEL_EXEMPT_CATEGORIES.has(category)) return true;
  if (isReadOnlyKey(key)) return true;
  if (effective === "READ") return false;
  return !(key.endsWith(".delete") || FULL_ONLY_KEYS.has(key));
}

/** The keys of a role still usable under a level — for presentation (which links to offer). */
export function keysUnderLevel(keys: Iterable<string>, level: ProjectAccessLevelValue | null | undefined): string[] {
  return [...keys].filter((key) => levelAllows(level, key));
}
