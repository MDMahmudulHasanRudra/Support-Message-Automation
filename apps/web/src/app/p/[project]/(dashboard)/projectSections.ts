import { isProjectAssignableKey, sanitizeProjectRoleKeys } from "@support-automation/shared";
import {
  NAV_GROUPS,
  navPermissionFor,
  OVERVIEW_LINK,
  REPORT_PAGES,
  REPORTS_LINK,
  SETTINGS_LINK,
  SETTINGS_SECTIONS,
  TEAM_REPORT_LINK,
  type NavLink,
} from "./navigation";

/**
 * Page-level project roles (PROJECT_ROLES.md §"Pages"): which modules and sub-modules a project role
 * opens, each as Read (open and look) or Full (also change things), plus which parts of the Dashboard
 * it shows.
 *
 * The catalogue is DERIVED from the sidebar (`NAV_GROUPS`, `SETTINGS_SECTIONS`, `REPORT_PAGES`), so a
 * Lead chooses from exactly the modules and sub-modules the members will see, in the same order, under
 * the same names. Only what the sidebar cannot say is written here: which keys a page's changes need
 * (`SECTION_RULES`), and the paths that belong to a page without being its own link (detail pages,
 * legacy redirects, its export routes).
 *
 * Every function here is pure; `server/permissions.ts` applies them to the request, the shell to the
 * sidebar. A role with no page selection at all (`sectionAccess` null — every role made before this,
 * and every global role) is governed by its keys exactly as before.
 */

export type SectionLevel = "READ" | "FULL";
/** A role's selection: section id → level. A section that is absent is hidden. */
export type SectionAccess = Readonly<Record<string, SectionLevel>>;

export interface AccessSection {
  /** The page's path (stable: routes never move), or `dashboard:<part>` for a part of the Overview. */
  id: string;
  label: string;
  description?: string;
  /** Path prefixes that belong to this section: its page, its detail pages, redirects and export routes. */
  paths: readonly string[];
  /** Keys a Read grant gives — enough to open the page and look. */
  readKeys: readonly string[];
  /** Keys a Full grant adds — what the page changes. */
  writeKeys: readonly string[];
  /** The levels a Lead may choose. A page that only opens to change something offers Full only. */
  levels: readonly SectionLevel[];
}

/** One sidebar entry: a single page, or an entry whose pages are tabs (Messages, Broadcast…). */
export interface AccessEntry {
  label: string;
  sections: readonly AccessSection[];
}

export interface AccessGroup {
  /** Null for a module with one list; the Settings module is split like its own rail. */
  label: string | null;
  entries: readonly AccessEntry[];
}

export interface AccessModule {
  id: string;
  label: string;
  description: string;
  groups: readonly AccessGroup[];
}

interface SectionRule {
  label?: string;
  /** Extra keys a Read grant gives (the page's own open key is added automatically). */
  read?: readonly string[];
  /** Keys a Full grant adds. */
  write?: readonly string[];
  /** The page opens only with a write key (a composer, an import): Full is the only choice. */
  fullOnly?: boolean;
  /** Other path prefixes that belong to this page. Several sections may claim one (a shared detail page). */
  also?: readonly string[];
}

/**
 * What each page CHANGES, by path. A page missing here is read-only: Read is its only choice. Keys are
 * the ones the page's own Server Actions check — `projectSections.test.ts` fails if a page's manage key
 * (its `pageAccess(view, manage)`) is missing from its section.
 */
const SECTION_RULES: Record<string, SectionRule> = {
  // Support
  "/conversations/all": { write: ["conversations.reply"], also: ["/conversations", "/conversations/whatsapp", "/api/channels/attachment"] },
  "/chat": { write: ["messages.reply"], also: ["/api/whatsapp/media", "/api/whatsapp/avatar", "/api/whatsapp/send-file"] },
  "/conversations/messenger": { write: ["conversations.reply"] },
  "/conversations/instagram": { write: ["conversations.reply"] },
  "/conversations/telegram": { write: ["conversations.reply"] },
  "/conversations/website": { write: ["conversations.reply"], also: ["/api/channels/attachment"] },
  "/messages": { label: "All messages (needs attention, ignored)", also: ["/ignored", "/needs-attention", "/api/whatsapp/media"] },
  "/messages/unanswered": { write: ["messages.reply"], also: ["/api/messages/support-response"] },
  "/messages/response-time": { also: ["/api/messages/support-response"] },
  "/support-assignment/unanswered": { write: ["support_assignment.assign"], also: ["/support-assignment"] },
  "/support-assignment/mine": { write: ["support_assignment.assign"], also: ["/support-assignment"] },
  "/support-assignment/completed": { write: ["support_assignment.assign"], also: ["/support-assignment"] },
  "/support-assignment/report": { also: ["/api/support-assignment/report"] },
  "/support-escalation": { write: ["escalations.manage"] },
  // Clients
  "/clients": {
    write: [
      "clients.create",
      "clients.update",
      "clients.archive",
      "clients.export",
      "clients.link_whatsapp_chat",
      "clients.link_whatsapp_group",
      "clients.manage_subscriptions",
    ],
    // The export and each client's photo.
    also: ["/api/clients"],
  },
  "/clients/subscriptions": { write: ["clients.manage_subscriptions"] },
  "/clients/dues": { write: ["clients.edit_billing"] },
  "/clients/payments": { write: ["clients.edit_billing"] },
  "/clients/import": { fullOnly: true, also: ["/api/clients/import"] },
  // Commerce
  "/commerce/orders": { write: ["orders.manage"] },
  "/commerce/products": { write: ["commerce.manage"] },
  "/sales": { write: ["sales.manage"] },
  "/commerce/shipments": { write: ["shipments.manage"] },
  "/settings/couriers": { write: ["couriers.manage"] },
  "/settings/woocommerce": { fullOnly: true },
  "/settings/shopify": { fullOnly: true },
  "/settings/api": { fullOnly: true },
  // Social Studio (SOCIAL_STUDIO.md). Writing, approving and publishing are separate keys on one page.
  "/social/posts": { write: ["social.edit", "social.approve", "social.publish"], also: ["/social/new", "/api/social/assets", "/api/social/upload"] },
  "/social/calendar": { write: ["social.publish"], also: ["/api/social/assets"] },
  "/social/media": { write: ["social.edit"], also: ["/api/social/assets", "/api/social/upload"] },
  "/social/campaigns": { write: ["social.edit"] },
  "/social/templates": { write: ["social.edit"] },
  "/social/analytics": { also: ["/api/social/export"] },
  "/social/accounts": { write: ["social.manage"], also: ["/api/social/meta"] },
  "/settings/social": { fullOnly: true },
  // Team
  "/team-management": { write: ["team_management.manage"], also: ["/api/team-management/export"] },
  "/team-management/schedule": { write: ["team_management.manage"] },
  "/team-management/leave": { write: ["team_management.manage"] },
  "/support-activity": { write: ["support_activity.manage"], also: ["/api/support-activity/export"] },
  // Reports (beyond what is derived from the report catalogue)
  "/team-report": { also: ["/api/team-report"] },
  "/support-activity/reports": { also: ["/api/support-activity/export"] },
  "/team-management/attendance": { also: ["/api/team-management/export"] },
  // WhatsApp
  "/accounts": { write: ["whatsapp.manage"] },
  "/groups": { write: ["whatsapp.manage"] },
  "/team-members": { write: ["whatsapp.manage"] },
  "/teams": { write: ["whatsapp.manage"] },
  "/group-message-sender": { fullOnly: true, read: ["bulk_messaging.view"], also: ["/group-message-sender/jobs"] },
  "/group-message-sender/history": { write: ["bulk_messaging.manage"], also: ["/group-message-sender/jobs"] },
  "/group-member-adder": { fullOnly: true, read: ["bulk_messaging.view"] },
  "/group-admin-maker": { write: ["bulk_messaging.manage"] },
  // Google Sheets
  "/google-sheets": { write: ["google_sheets.edit", "google_sheets.manage"], also: ["/api/google-sheets/signal"] },
  "/google-sheets/activity": { write: ["google_sheets.manage"] },
  "/google-sheets/reports": { also: ["/api/google-sheets/report-export"] },
  "/google-sheets/identity": { also: ["/api/google-sheets/identity"] },
  // Automation
  "/rules": {
    read: ["automation_rules.bulk_export"],
    write: ["automation_rules.create", "automation_rules.edit", "automation_rules.delete", "automation_rules.activate", "automation_rules.bulk_import"],
    also: ["/api/automation-rules"],
  },
  "/automation-control": { write: ["settings.edit"] },
  // AI Learning
  "/ai-learning": { write: ["ai_learning.manage"] },
  "/ai-learning/knowledge-base": { write: ["ai_learning.manage"], also: ["/api/knowledge/export"] },
  "/ai-learning/knowledge-base/review": { write: ["ai_learning.manage"] },
  "/ai-learning/knowledge-base/import": { fullOnly: true, read: ["ai_learning.view"], also: ["/api/knowledge/import-template"] },
  "/ai-learning/communication-style": { write: ["ai_learning.manage"] },
  // Conversation Learning
  "/conversation-learning": { write: ["conversation_learning.manage"] },
  "/conversation-learning/sandbox": { write: ["conversation_learning.manage"], also: ["/api/sandbox/export"] },
  "/conversation-learning/knowledge-builder": { write: ["conversation_learning.manage"] },
  "/conversation-learning/pattern-candidates": { write: ["conversation_learning.manage"] },
  "/conversation-learning/unknown-patterns": { write: ["conversation_learning.manage"] },
  "/conversation-learning/rule-proposals": { write: ["conversation_learning.manage"] },
  // System
  "/notifications": { write: ["settings.edit"] },
  // Settings
  "/settings": { write: ["settings.edit"] },
  "/notifications/events": { write: ["settings.edit"] },
  "/notifications/templates": { write: ["settings.edit"] },
  "/accounts/routing": { write: ["whatsapp.manage"] },
  "/settings/media-storage": { write: ["settings.edit"] },
  "/group-message-sender/settings": { write: ["bulk_messaging.manage"] },
  "/group-member-adder/settings": { write: ["bulk_messaging.manage"] },
  "/ai-learning/settings": { write: ["ai_settings.edit"] },
  "/ai-learning/providers": { write: ["ai_settings.edit"] },
  "/ai-learning/models": { write: ["ai_settings.edit"] },
  "/integrations/forge": { write: ["ai_learning.manage"] },
  "/conversation-learning/settings": { write: ["conversation_learning.manage"] },
  "/support-escalation/policies": { write: ["escalations.manage"] },
  "/support-activity/settings": { write: ["support_activity.manage"], also: ["/support-activity/keywords", "/support-activity/rules"] },
  "/settings/mood-detection": { write: ["settings.edit"] },
  "/support-assignment/settings": { write: ["support_assignment.manage"] },
  "/team-management/shifts": { fullOnly: true, read: ["team_management.view"] },
  "/team-management/settings": { fullOnly: true, read: ["team_management.view"] },
  "/settings/channels": { write: ["channels.manage"], also: ["/api/meta/connect", "/api/meta/claim", "/api/webchat/wordpress"] },
  "/settings/email": { fullOnly: true },
  "/settings/clients": { fullOnly: true },
  "/settings/google-sheets": { write: ["google_sheets.manage"], also: ["/api/google-sheets/connect"] },
};

/** The parts of the Overview a role may show. Each is one block of the page; none gives a key. */
export const DASHBOARD_PARTS = [
  { id: "dashboard:alerts", label: "Things that need attention", description: "Worker offline, numbers not receiving, automation paused, errors." },
  { id: "dashboard:tiles", label: "Summary numbers", description: "Connected accounts, waiting customers, messages, rules, queues." },
  { id: "dashboard:metrics", label: "Metrics and charts", description: "Message volume, decisions, delivery, AI answers, wait times, busiest groups." },
  { id: "dashboard:modules", label: "Module status cards", description: "One health card per module." },
  { id: "dashboard:stream", label: "Live message stream", description: "The latest customer messages and what automation did with them (shows message text)." },
] as const;
export type DashboardPartId = (typeof DASHBOARD_PARTS)[number]["id"];

function pathOf(href: string): string {
  return href.split("?")[0]!;
}

/** A sidebar link as a section, or null for a platform page (its key is never a project's to give). */
function sectionFor(link: NavLink, labelOverride?: string): AccessSection | null {
  const path = pathOf(link.href);
  const openKey = navPermissionFor(path);
  if (!openKey || !isProjectAssignableKey(openKey)) return null;
  const rule = SECTION_RULES[path] ?? {};
  const read = new Set(rule.read ?? []);
  const write = new Set(rule.write ?? []);
  (rule.fullOnly ? write : read).add(openKey);
  for (const key of read) write.delete(key);
  return {
    id: path,
    label: rule.label ?? labelOverride ?? link.label,
    paths: [path, ...(rule.also ?? [])],
    readKeys: [...read],
    writeKeys: [...write],
    levels: rule.fullOnly ? ["FULL"] : write.size > 0 ? ["READ", "FULL"] : ["READ"],
  };
}

/** A sidebar entry as an entry: its tabs as sections, tabs on one page (a query string) as one. */
function entryFor(link: NavLink, taken: Set<string>): AccessEntry | null {
  const seen = new Set<string>();
  const sections = (link.tabs ?? [link]).flatMap((tab) => {
    const path = pathOf(tab.href);
    if (seen.has(path) || taken.has(path)) return [];
    seen.add(path);
    const section = sectionFor(tab);
    if (!section) return [];
    taken.add(path);
    return [section];
  });
  return sections.length ? { label: link.label, sections } : null;
}

const REPORTS_MODULE_ID = "reports";

function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function buildModules(): AccessModule[] {
  const taken = new Set<string>();
  const modules: AccessModule[] = [
    {
      id: "dashboard",
      label: "Dashboard",
      description: "The Overview members land on. Choose which parts of it they see.",
      groups: [
        {
          label: null,
          entries: DASHBOARD_PARTS.map((part) => ({
            label: part.label,
            sections: [{ id: part.id, label: part.label, description: part.description, paths: [], readKeys: [], writeKeys: [], levels: ["READ"] as const }],
          })),
        },
      ],
    },
  ];
  for (const group of NAV_GROUPS) {
    let entries: AccessEntry[];
    const isReports = group.links.includes(REPORTS_LINK);
    if (isReports) {
      // The Reports module is every report, Team Report first — not the hub that lists them.
      const reports: NavLink[] = [TEAM_REPORT_LINK, ...REPORT_PAGES.filter((page) => page.href !== TEAM_REPORT_LINK.href)];
      entries = reports.flatMap((page) => entryFor(page, taken) ?? []);
    } else {
      entries = group.links.filter((link) => link !== SETTINGS_LINK).flatMap((link) => entryFor(link, taken) ?? []);
    }
    if (entries.length) {
      modules.push({ id: isReports ? REPORTS_MODULE_ID : slug(group.label), label: group.label, description: "", groups: [{ label: null, entries }] });
    }
    if (group.links.includes(SETTINGS_LINK)) {
      // Settings sits right after System, where its one sidebar link lives, split like its own rail.
      const groups = SETTINGS_SECTIONS.map((section) => ({
        label: section.label,
        entries: section.links.flatMap((link) => entryFor(link, taken) ?? []),
      })).filter((g) => g.entries.length > 0);
      if (groups.length) modules.push({ id: "settings", label: "Settings", description: "Configuration pages. Full lets a member change them.", groups });
    }
  }
  return modules;
}

/** Every module a Lead can give, in sidebar order, Dashboard first. */
export const ACCESS_MODULES: readonly AccessModule[] = buildModules();

export const ALL_SECTIONS: readonly AccessSection[] = ACCESS_MODULES.flatMap((m) => m.groups.flatMap((g) => g.entries.flatMap((e) => e.sections)));

const SECTION_BY_ID: ReadonlyMap<string, AccessSection> = new Map(ALL_SECTIONS.map((s) => [s.id, s]));

export function sectionById(id: string): AccessSection | null {
  return SECTION_BY_ID.get(id) ?? null;
}

/** Keys a Read grant can give anywhere. A key outside this set changes something. */
const SECTION_READ_KEYS: ReadonlySet<string> = new Set(ALL_SECTIONS.flatMap((s) => s.readKeys));

export function isSectionReadKey(key: string): boolean {
  return SECTION_READ_KEYS.has(key);
}

/** Pages whose key is the platform's (App Users, Permission Modules, Security, this project's administration…). */
const PLATFORM_PATHS: readonly string[] = NAV_GROUPS.flatMap((group) => group.links.flatMap((link) => link.tabs ?? [link]))
  .concat(SETTINGS_SECTIONS.flatMap((section) => section.links))
  .map((link) => pathOf(link.href))
  .filter((path) => {
    const key = navPermissionFor(path);
    return key !== null && !isProjectAssignableKey(key);
  });

/** The Reports module's sections — the ones that open the reports hub. */
const REPORT_SECTION_IDS: readonly string[] = (ACCESS_MODULES.find((m) => m.id === REPORTS_MODULE_ID)?.groups ?? []).flatMap((g) =>
  g.entries.flatMap((e) => e.sections.map((s) => s.id)),
);

/** prefix → the sections claiming it. Built once; several sections may claim one shared prefix. */
const CLAIMS: ReadonlyMap<string, readonly string[]> = (() => {
  const claims = new Map<string, string[]>();
  const add = (prefix: string, id: string) => {
    const list = claims.get(prefix) ?? [];
    if (!list.includes(id)) list.push(id);
    claims.set(prefix, list);
  };
  for (const section of ALL_SECTIONS) for (const path of section.paths) add(path, section.id);
  // The reports hub lists whatever reports the role has; it opens when any of them does.
  for (const id of REPORT_SECTION_IDS) add(REPORTS_LINK.href, id);
  for (const id of ALL_SECTIONS.filter((s) => s.id.startsWith("/reports/")).map((s) => s.id)) add(`/api${id}`, id);
  return claims;
})();

const CLAIM_PREFIXES: readonly string[] = [...CLAIMS.keys(), ...PLATFORM_PATHS, OVERVIEW_LINK.href].sort((a, b) => b.length - a.length);

export type PathClaim = { kind: "OVERVIEW" } | { kind: "PLATFORM" } | { kind: "SECTIONS"; ids: readonly string[] } | { kind: "UNKNOWN" };

function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** Which part of the catalogue a path belongs to — the longest matching prefix. */
export function claimForPath(rawPath: string): PathClaim {
  const path = pathOf(rawPath).replace(/\/+$/, "") || "/";
  if (path === "/" || path === OVERVIEW_LINK.href) return { kind: "OVERVIEW" };
  const prefix = CLAIM_PREFIXES.find((p) => under(path, p));
  if (!prefix) return { kind: "UNKNOWN" };
  if (prefix === OVERVIEW_LINK.href) return { kind: "OVERVIEW" };
  const ids = CLAIMS.get(prefix);
  if (ids) return { kind: "SECTIONS", ids };
  return { kind: "PLATFORM" };
}

/** The highest level the selection grants among these sections, or null when it grants none of them. */
export function levelOf(ids: readonly string[], access: SectionAccess): SectionLevel | null {
  let best: SectionLevel | null = null;
  for (const id of ids) {
    const level = access[id];
    if (level === "FULL") return "FULL";
    if (level === "READ") best = "READ";
  }
  return best;
}

/** Whether a page opens for this selection. The Overview always does (it shows only what was chosen). */
export function canOpenPath(path: string, access: SectionAccess): boolean {
  const claim = claimForPath(path);
  if (claim.kind === "OVERVIEW" || claim.kind === "PLATFORM") return true;
  if (claim.kind === "UNKNOWN") return false;
  return levelOf(claim.ids, access) !== null;
}

/**
 * Whether a key may be used from this page under this selection. Platform keys are never a project
 * role's business (kept or refused by the global role alone). Otherwise reading needs the page
 * granted at all, changing needs it at Full; the Overview reads only.
 */
export function pathPermitsKey(path: string, access: SectionAccess, key: string): boolean {
  if (!isProjectAssignableKey(key)) return true;
  const write = !isSectionReadKey(key);
  const claim = claimForPath(path);
  if (claim.kind === "OVERVIEW" || claim.kind === "PLATFORM") return !write;
  if (claim.kind === "UNKNOWN") return false;
  const level = levelOf(claim.ids, access);
  return level !== null && (!write || level === "FULL");
}

/** The same rule for an action bound to its own pages (`checkPermission(key, { sections })`). */
export function sectionsPermitKey(ids: readonly string[], access: SectionAccess, key: string): boolean {
  if (!isProjectAssignableKey(key)) return true;
  const level = levelOf(ids, access);
  return level !== null && (isSectionReadKey(key) || level === "FULL");
}

/** Keeps only known sections at a level each offers. Anything else in a stored or submitted value is dropped. */
export function sanitizeSectionAccess(raw: unknown): Record<string, SectionLevel> {
  const out: Record<string, SectionLevel> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const section of ALL_SECTIONS) {
    const level = (raw as Record<string, unknown>)[section.id];
    if ((level === "READ" || level === "FULL") && section.levels.includes(level)) out[section.id] = level;
  }
  return out;
}

/**
 * The keys a selection gives, minus the write keys the Lead switched off under "Fine-tune". Read keys
 * cannot be switched off: a page granted at all must open.
 */
export function keysForSectionAccess(access: SectionAccess, excludedWriteKeys: Iterable<string> = []): string[] {
  const excluded = new Set(excludedWriteKeys);
  const keys = new Set<string>();
  for (const [id, level] of Object.entries(access)) {
    const section = SECTION_BY_ID.get(id);
    if (!section || !section.levels.includes(level)) continue;
    for (const key of section.readKeys) keys.add(key);
    if (level === "FULL") for (const key of section.writeKeys) if (!excluded.has(key)) keys.add(key);
  }
  return sanitizeProjectRoleKeys(keys);
}

/** Every write key the selection's Full pages give — the Fine-tune list. */
export function writeKeysOf(access: SectionAccess): string[] {
  const keys = new Set<string>();
  for (const [id, level] of Object.entries(access)) {
    const section = SECTION_BY_ID.get(id);
    if (section && level === "FULL") for (const key of section.writeKeys) keys.add(key);
  }
  return sanitizeProjectRoleKeys(keys);
}

/**
 * A starting selection for a role saved before pages existed (keys only): a page is Full when the role
 * holds everything it changes, Read when it holds what it opens with, hidden otherwise; the whole
 * Dashboard, which every role saw. Used only to fill the form — nothing is converted until saved.
 */
export function sectionAccessFromKeys(keys: Iterable<string>): Record<string, SectionLevel> {
  const held = new Set(keys);
  const out: Record<string, SectionLevel> = {};
  for (const section of ALL_SECTIONS) {
    if (section.id.startsWith("dashboard:")) {
      out[section.id] = "READ";
      continue;
    }
    const opens = section.readKeys.every((k) => held.has(k));
    const changes = section.writeKeys.length > 0 && section.writeKeys.every((k) => held.has(k));
    if (section.levels.includes("FULL") && changes && opens) out[section.id] = "FULL";
    else if (section.levels.includes("READ") && opens && section.readKeys.length > 0) out[section.id] = "READ";
  }
  return out;
}

/** The Dashboard parts a selection shows. */
export function dashboardPartsOf(access: SectionAccess): Set<DashboardPartId> {
  return new Set(DASHBOARD_PARTS.map((p) => p.id).filter((id) => access[id] !== undefined));
}

/** The pages a selection opens, in sidebar order — the Overview's "Your pages" when it shows no Dashboard. */
export function openableSections(access: SectionAccess): Array<{ module: string; section: AccessSection }> {
  return ACCESS_MODULES.filter((m) => m.id !== "dashboard").flatMap((m) =>
    m.groups.flatMap((g) => g.entries.flatMap((e) => e.sections.filter((s) => access[s.id] !== undefined).map((section) => ({ module: m.label, section })))),
  );
}

/** A section's name for a sentence ("Accounts", "Broadcast · Broadcast history"), or null. */
export function describePath(path: string): string | null {
  const claim = claimForPath(path);
  if (claim.kind !== "SECTIONS") return null;
  const section = SECTION_BY_ID.get(claim.ids[0]!);
  return section ? section.label : null;
}
