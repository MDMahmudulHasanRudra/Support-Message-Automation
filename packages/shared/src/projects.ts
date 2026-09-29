/**
 * Projects on the platform (MULTI_PROJECT_PLAN.md §8): the rules for naming one and for moving it
 * through its lifecycle. Pure, so the Main Admin Portal's form, its server actions and the tests all
 * apply exactly the same rules.
 */

export const PROJECT_STATUSES = ["SETUP", "ACTIVE", "SUSPENDED", "ARCHIVED"] as const;
export type ProjectStatusValue = (typeof PROJECT_STATUSES)[number];

export function isProjectStatus(value: unknown): value is ProjectStatusValue {
  return typeof value === "string" && (PROJECT_STATUSES as readonly string[]).includes(value);
}

export const PROJECT_STATUS_LABELS: Record<ProjectStatusValue, string> = {
  SETUP: "Setting up",
  ACTIVE: "Active",
  SUSPENDED: "Suspended",
  ARCHIVED: "Archived",
};

/** What each status means for the people using the project — shown beside the status control. */
export const PROJECT_STATUS_DESCRIPTIONS: Record<ProjectStatusValue, string> = {
  SETUP: "Usable, so it can be configured. Nothing connects until a WhatsApp account is linked.",
  ACTIVE: "Normal operation.",
  SUSPENDED:
    "Read-only. Nothing is sent and background jobs stop; incoming messages are still stored, without automation.",
  ARCHIVED: "Read-only and hidden from the switcher. Its WhatsApp accounts are disconnected. Nothing is deleted.",
};

/** Statuses a new project may start in. Suspending or archiving something that never ran means nothing. */
export const CREATABLE_PROJECT_STATUSES: readonly ProjectStatusValue[] = ["SETUP", "ACTIVE"];

/**
 * SETUP → ACTIVE ⇄ SUSPENDED → ARCHIVED (§8). Archiving is final from the portal: an archived
 * project keeps every row, but bringing one back is a deliberate database operation, not a click.
 */
const TRANSITIONS: Record<ProjectStatusValue, readonly ProjectStatusValue[]> = {
  SETUP: ["ACTIVE", "ARCHIVED"],
  ACTIVE: ["SUSPENDED", "ARCHIVED"],
  SUSPENDED: ["ACTIVE", "ARCHIVED"],
  ARCHIVED: [],
};

export function allowedProjectTransitions(from: ProjectStatusValue): readonly ProjectStatusValue[] {
  return TRANSITIONS[from];
}

export function canTransitionProject(from: ProjectStatusValue, to: ProjectStatusValue): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Read-only in the operator UI: every write is refused (§4.1 step 4). */
export function isReadOnlyProjectStatus(status: ProjectStatusValue): boolean {
  return status === "SUSPENDED" || status === "ARCHIVED";
}

/** Whether the worker does outward or background work for the project (sending, scanners). */
export function isOperatingProjectStatus(status: ProjectStatusValue): boolean {
  return status === "SETUP" || status === "ACTIVE";
}

export const PROJECT_NAME_MAX = 80;
export const PROJECT_SLUG_MAX = 48;

/**
 * Words a slug may not be. A slug only ever appears after `/p/`, so none of these can collide with
 * a route today — they are refused because each reads as a place in the product rather than a
 * project ("/p/admin", "/p/api", "/p/new"), and a project called that would be a trap for anyone
 * reading a URL or a log line.
 */
export const RESERVED_PROJECT_SLUGS: readonly string[] = [
  "admin",
  "all",
  "api",
  "app",
  "assets",
  "create",
  "dashboard",
  "edit",
  "login",
  "logout",
  "main",
  "new",
  "open",
  "p",
  "platform",
  "project",
  "projects",
  "settings",
  "static",
  "system",
  "www",
];

/** Lower-case letters, digits and single hyphens between them; 2–48 characters. */
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){1,47}$/;

export function normalizeProjectName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/** A name's error, or null. */
export function validateProjectName(name: string): string | null {
  if (!name) return "Give the project a name.";
  if (name.length > PROJECT_NAME_MAX) return `Keep the project name under ${PROJECT_NAME_MAX} characters.`;
  return null;
}

/** A slug's error, or null. Checked as typed: the form shows the lower-case version, it does not fix it silently. */
export function validateProjectSlug(slug: string): string | null {
  if (!slug) return "Give the project a slug — it becomes the project's address, /p/<slug>/.";
  if (RESERVED_PROJECT_SLUGS.includes(slug)) return `"${slug}" is reserved. Choose another slug.`;
  if (slug.length < 2 || slug.length > PROJECT_SLUG_MAX) {
    return `A slug is 2 to ${PROJECT_SLUG_MAX} characters.`;
  }
  if (!SLUG_PATTERN.test(slug)) {
    return "Use lower-case letters, digits and single hyphens between them — for example isp-digital.";
  }
  return null;
}

/** "Bizify Ltd." → "bizify-ltd": the slug the form offers for a name, which the admin can change. */
export function suggestProjectSlug(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, PROJECT_SLUG_MAX)
    .replace(/-+$/g, "");
}

/**
 * The shifts this office runs today, created for the original project by the seed and for every new
 * project when it is created. SEED DATA, never a business rule: nothing may branch on these names or
 * times (CLAUDE.md, Team Management). Minutes are measured from local midnight.
 */
export const DEFAULT_SHIFT_TEMPLATES = [
  { name: "Morning", startMinute: 10 * 60, endMinute: 19 * 60, requiredHeadcount: 2, colourSlot: 1, position: 1 },
  { name: "Mid", startMinute: 12 * 60, endMinute: 21 * 60, requiredHeadcount: 2, colourSlot: 2, position: 2 },
  { name: "Late", startMinute: 13 * 60, endMinute: 22 * 60, requiredHeadcount: 1, colourSlot: 3, position: 3 },
] as const;
