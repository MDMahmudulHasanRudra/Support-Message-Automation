import {
  Activity,
  AlertCircle,
  BarChart3,
  Bell,
  BellRing,
  BookOpen,
  CalendarDays,
  ClipboardCheck,
  ClipboardList,
  Clock,
  Cpu,
  EyeOff,
  FileEdit,
  FileUp,
  Fingerprint,
  FlaskConical,
  Gauge,
  GraduationCap,
  History,
  KeyRound,
  LayoutDashboard,
  Link2,
  ListChecks,
  MessageCircleMore,
  MessageSquareQuote,
  Megaphone,
  MessagesSquare,
  PackageSearch,
  Power,
  Route,
  Send,
  Settings as SettingsIcon,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  Tag,
  Terminal as ConsoleIcon,
  UserCog,
  UserPlus,
  Users,
  Waypoints,
  type LucideIcon,
} from "lucide-react";

/**
 * The single source of truth for dashboard navigation. Lives outside Sidebar.tsx
 * because three things now read it — the sidebar, the ⌘K command palette, and the
 * header's location label — and a second copy would drift the moment a link moved.
 */

export interface NavLink {
  href: string;
  label: string;
  icon: LucideIcon;
}

export interface NavGroup {
  label: string;
  links: NavLink[];
  /**
   * The coarser section this group sits under in the sidebar — an added VISUAL tier, not a
   * restructure. Every existing group keeps its own label, its own links, and its own position;
   * this only draws a section header above a run of adjacent groups so the ~75 routes read as a
   * handful of departments rather than one long undifferentiated list. `resolveNavLocation` and
   * the command palette ignore it entirely -- they already work at the group/link level.
   */
  section: "Support Operations" | "Automation & AI" | "Channels & Integrations" | "System";
}

// The one always-visible landing page — pinned above the scrollable groups below rather than
// living inside a redundant single-item group of its own.
export const OVERVIEW_LINK: NavLink = { href: "/overview", label: "Overview", icon: LayoutDashboard };

/**
 * Every page whose job is CONFIGURATION, gathered into one Settings module.
 *
 * They used to sit as the last link of whichever group they configured: twenty "Settings", "Setup",
 * "Limits" and "Policies" entries spread across ten groups, so the sidebar was long and the screen
 * you wanted was always somewhere else. The pages themselves did not move. Every route, form, save
 * action and permission check is exactly as it was, which keeps bookmarks, in-page links and the
 * settings the worker reads untouched. Only where they are OFFERED changed: one sidebar link, plus
 * the settings rail (`SettingsNav`) drawn beside any of these pages.
 *
 * Deliberately left out, because they are places you work IN rather than configure: Automation
 * Control (the kill switch is an operational control, used under pressure), WhatsApp Accounts
 * (linking and reconnecting), Groups, Team Members, Users and Permission Modules (records, not
 * preferences), Issues, and the notification delivery log.
 */
export interface SettingsSection {
  label: string;
  description: string;
  links: NavLink[];
}

export const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    label: "General",
    description: "How automation behaves, and how sign-in is protected.",
    links: [
      { href: "/settings", label: "Automation & Safety", icon: SettingsIcon },
      { href: "/settings/security", label: "Security", icon: SlidersHorizontal },
    ],
  },
  {
    label: "Notifications",
    description: "Which alerts are raised, where they go, and what they say.",
    links: [
      { href: "/notifications/events", label: "Notification Center", icon: BellRing },
      { href: "/notifications/templates", label: "Message Templates", icon: MessageSquareQuote },
    ],
  },
  {
    label: "WhatsApp",
    description: "Which number sends each kind of notification.",
    links: [{ href: "/accounts/routing", label: "Account Routing", icon: Route }],
  },
  {
    label: "Bulk Messaging",
    description: "Pace and size limits that protect the number.",
    links: [
      { href: "/group-message-sender/settings", label: "Sending Limits", icon: Send },
      { href: "/group-member-adder/settings", label: "Add-to-Groups Limits", icon: UserPlus },
    ],
  },
  {
    label: "AI",
    description: "Providers, models, behaviour and product knowledge.",
    links: [
      { href: "/ai-learning/settings", label: "AI Settings", icon: Sparkles },
      { href: "/ai-learning/providers", label: "AI Providers", icon: KeyRound },
      { href: "/ai-learning/models", label: "AI Models", icon: Cpu },
      { href: "/integrations/forge", label: "Product Knowledge", icon: PackageSearch },
      { href: "/conversation-learning/settings", label: "Conversation Learning", icon: Waypoints },
    ],
  },
  {
    label: "Support",
    description: "Escalation timers and what counts as support work.",
    links: [
      { href: "/support-escalation/policies", label: "Escalation Policies", icon: ShieldAlert },
      { href: "/support-activity/settings", label: "Support Activity Setup", icon: Activity },
    ],
  },
  {
    label: "Team Management",
    description: "Shift templates and roster rules.",
    links: [
      { href: "/team-management/shifts", label: "Shifts", icon: Clock },
      { href: "/team-management/settings", label: "Team Settings", icon: CalendarDays },
    ],
  },
  {
    label: "Microsoft Teams",
    description: "The connection, which channels are read, and how issues resolve.",
    links: [
      { href: "/integrations/teams", label: "Connection", icon: Link2 },
      { href: "/integrations/teams/manage", label: "Teams & Channels", icon: Users },
      { href: "/integrations/teams/rules", label: "Resolution Rules", icon: ClipboardList },
      { href: "/integrations/teams/keywords", label: "Resolution Keywords", icon: Tag },
      { href: "/integrations/teams/settings", label: "Teams Settings", icon: SettingsIcon },
    ],
  },
];

const SETTINGS_PATHS = SETTINGS_SECTIONS.flatMap((section) => section.links.map((link) => link.href));

/** The single sidebar entry for all of the above. Its href is re-pointed per role in `navGroupsFor`. */
export const SETTINGS_LINK: NavLink = { href: "/settings", label: "Settings", icon: SettingsIcon };

/**
 * Whether a path belongs to the Settings module: one of its pages or anything beneath one (an edit
 * form under Resolution Rules is still Settings). Exact-or-child only, so `/accounts/routing` never
 * claims `/accounts`, which is not a setting.
 */
export function isSettingsPath(pathname: string): boolean {
  return SETTINGS_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

/** The Settings sections reduced to the pages this role can open. Empty sections are dropped. */
export function settingsSectionsFor(granted: ReadonlySet<string>): SettingsSection[] {
  return SETTINGS_SECTIONS.map((section) => ({
    ...section,
    links: section.links.filter((link) => {
      const key = navPermissionFor(link.href);
      return key === null || granted.has(key);
    }),
  })).filter((section) => section.links.length > 0);
}

// Ordered for day-to-day frequency: live/operational areas checked constantly (messages,
// escalations, team activity) first, setup/config areas checked occasionally next, advanced
// analytical modules and system admin — checked rarely — last.
export const NAV_GROUPS: NavGroup[] = [
  {
    section: "Support Operations",
    label: "Messages",
    links: [
      { href: "/chat", label: "WhatsApp Chat", icon: MessageCircleMore },
      { href: "/messages", label: "All Messages", icon: MessagesSquare },
      { href: "/messages?decision=SUPPORT_REQUIRED", label: "Needs Attention", icon: AlertCircle },
      { href: "/messages?decision=IGNORE", label: "Ignored Messages", icon: EyeOff },
    ],
  },
  {
    section: "Support Operations",
    label: "Escalations",
    links: [
      { href: "/support-escalation", label: "Active Cases", icon: ShieldAlert },
    ],
  },
  {
    section: "Support Operations",
    label: "Support Activity",
    links: [
      { href: "/support-activity/team", label: "Team Performance", icon: Users },
      { href: "/support-activity", label: "Activity Feed", icon: Activity },
      { href: "/support-activity/reports", label: "Reports", icon: BarChart3 },
    ],
  },
  {
    // After Support Activity, before Teams Integration: this group is checked daily (who is on,
    // who is short) which is what `navigation.ts` orders by. Internal Team Members deliberately
    // stays under WhatsApp — one roster, linked to from here, never a second copy of it.
    section: "Support Operations",
    label: "Team Management",
    links: [
      { href: "/team-management", label: "Today", icon: Users },
      { href: "/team-management/schedule", label: "Roster", icon: CalendarDays },
      { href: "/team-management/leave", label: "Leave", icon: ClipboardList },
      { href: "/team-management/attendance", label: "Duty History", icon: BarChart3 },
    ],
  },
  {
    section: "Support Operations",
    label: "Teams Integration",
    links: [
      { href: "/issues", label: "Issues", icon: Link2 },
    ],
  },
  {
    section: "Channels & Integrations",
    label: "WhatsApp",
    links: [
      { href: "/accounts", label: "WhatsApp Accounts", icon: Smartphone },
      { href: "/groups", label: "Groups", icon: Users },
      { href: "/team-members", label: "Internal Team Members", icon: UserCog },
    ],
  },
  {
    section: "Automation & AI",
    label: "Automation",
    links: [
      { href: "/rules", label: "Automation Rules", icon: ListChecks },
      { href: "/rules/tester", label: "Rule Tester", icon: FlaskConical },
      { href: "/automation-control", label: "Automation Control", icon: Power },
    ],
  },
  {
    section: "Channels & Integrations",
    label: "Bulk Messaging",
    links: [
      { href: "/group-message-sender", label: "Group Message Sender", icon: Send },
      { href: "/group-message-sender/history", label: "Broadcast History", icon: History },
      { href: "/group-member-adder", label: "Add Number to Groups", icon: UserPlus },
    ],
  },
  {
    section: "Automation & AI",
    label: "AI Learning",
    links: [
      { href: "/ai-learning", label: "Overview", icon: Sparkles },
      { href: "/ai-learning/activity", label: "AI Activity", icon: Gauge },
      { href: "/ai-learning/knowledge-base", label: "Knowledge Base", icon: BookOpen },
      { href: "/ai-learning/knowledge-base/import", label: "Import Knowledge", icon: FileUp },
      { href: "/ai-learning/knowledge-base/review", label: "Pending Review", icon: ClipboardCheck },
      { href: "/ai-learning/communication-style", label: "Communication Style", icon: MessageSquareQuote },
    ],
  },
  {
    section: "Automation & AI",
    label: "Conversation Learning",
    links: [
      { href: "/conversation-learning", label: "Overview", icon: Waypoints },
      { href: "/conversation-learning/sandbox", label: "AI Sandbox", icon: FlaskConical },
      { href: "/conversation-learning/knowledge-builder", label: "Knowledge Builder", icon: GraduationCap },
      { href: "/conversation-learning/pattern-candidates", label: "Pattern Candidates", icon: Fingerprint },
      { href: "/conversation-learning/unknown-patterns", label: "Unknown Patterns", icon: EyeOff },
      { href: "/conversation-learning/rule-proposals", label: "Rule Proposals", icon: ClipboardCheck },
    ],
  },
  {
    section: "System",
    label: "System",
    links: [
      { href: "/notifications", label: "Notifications", icon: Bell },
      { href: "/logs", label: "System Logs", icon: ConsoleIcon },
      SETTINGS_LINK,
    ],
  },
  {
    section: "System",
    label: "Users & Permissions",
    links: [
      { href: "/users", label: "App Users", icon: UserCog },
      { href: "/permissions", label: "Permission Modules", icon: ShieldCheck },
    ],
  },
  {
    // Last, deliberately: this is a changelog, not an operational surface — nobody needs it in
    // front of them daily the way Messages or Team Management are, so it sits after every group
    // that is checked routinely rather than displacing one of them.
    section: "System",
    label: "Release Notes",
    links: [
      { href: "/release-notes", label: "Release Notes", icon: Megaphone },
      { href: "/release-notes/manage", label: "Manage Releases", icon: FileEdit },
    ],
  },
];

/**
 * The permission a link's page checks before it will open — so the sidebar and command palette
 * only offer pages this role can actually reach.
 *
 * Until permissions were enforced everywhere this did not matter: every link opened. Now a link a
 * role cannot open bounces to the Overview, and a sidebar full of those is a sidebar that lies. The
 * keys here must match the page's own gate; `navPermissions.test.ts`-style drift is caught by the
 * check run against every page file when this was written, and a mismatch in the safe direction
 * (showing a link that then refuses) is only an inconvenience, since the page still enforces.
 *
 * Exact paths first, for pages that need more than their module's view key: the two broadcast
 * composers exist only to launch a send and require the manage key to open.
 */
const NAV_KEY_EXACT: Record<string, string> = {
  "/group-message-sender": "bulk_messaging.manage",
  "/group-member-adder": "bulk_messaging.manage",
  "/ai-learning/knowledge-base/import": "ai_learning.manage",
  "/release-notes/manage": "release_notes.manage",
  // Team Management's own pages already required manage for these two before this map existed.
  "/team-management/shifts": "team_management.manage",
  "/team-management/settings": "team_management.manage",
};

/** Longest prefix wins, so `/ai-learning/providers` resolves before `/ai-learning`. */
const NAV_KEY_PREFIX: Array<[string, string]> = [
  ["/chat", "messages.view"],
  ["/messages", "messages.view"],
  ["/support-escalation", "escalations.view"],
  ["/support-activity", "support_activity.view"],
  ["/team-management", "team_management.view"],
  ["/issues", "teams_integration.view"],
  ["/integrations/teams", "teams_integration.view"],
  ["/accounts", "whatsapp.view"],
  ["/groups", "whatsapp.view"],
  ["/team-members", "whatsapp.view"],
  ["/rules", "automation_rules.view"],
  ["/automation-control", "settings.view"],
  ["/group-message-sender", "bulk_messaging.view"],
  ["/group-member-adder", "bulk_messaging.view"],
  ["/ai-learning/providers", "ai_settings.view"],
  ["/ai-learning/models", "ai_settings.view"],
  ["/ai-learning/settings", "ai_settings.view"],
  ["/ai-learning", "ai_learning.view"],
  ["/integrations/forge", "ai_learning.view"],
  ["/conversation-learning", "conversation_learning.view"],
  ["/notifications", "notifications.view"],
  ["/settings/security", "security_settings.view"],
  ["/settings", "settings.view"],
  ["/logs", "system_logs.view"],
  ["/users", "users.view"],
  ["/permissions", "permissions.view"],
  ["/release-notes", "release_notes.view"],
].sort((a, b) => b[0].length - a[0].length) as Array<[string, string]>;

/** The key a link needs, or null for a page every signed-in user may open (the Overview). */
export function navPermissionFor(href: string): string | null {
  const path = href.split("?")[0]!;
  if (path in NAV_KEY_EXACT) return NAV_KEY_EXACT[path]!;
  const hit = NAV_KEY_PREFIX.find(([prefix]) => path === prefix || path.startsWith(`${prefix}/`));
  return hit ? hit[1] : null;
}

/** The nav, reduced to what a role can open. Groups left empty are dropped rather than shown bare. */
export function navGroupsFor(granted: ReadonlySet<string>): NavGroup[] {
  // Settings is shown whenever the role can open ANY settings page, and opens the first one it can:
  // a role with AI access but no general settings access must still find its way to AI Settings.
  const firstSettingsPage = settingsSectionsFor(granted)[0]?.links[0] ?? null;
  return NAV_GROUPS.map((group) => ({
    ...group,
    links: group.links.flatMap((link) => {
      if (link === SETTINGS_LINK) return firstSettingsPage ? [{ ...SETTINGS_LINK, href: firstSettingsPage.href }] : [];
      const key = navPermissionFor(link.href);
      return key === null || granted.has(key) ? [link] : [];
    }),
  })).filter((group) => group.links.length > 0);
}

export function isNavActive(pathname: string, search: URLSearchParams, href: string, label?: string) {
  // The one Settings entry stands for the whole module, so it stays lit on every settings page.
  if (label === SETTINGS_LINK.label && isSettingsPath(href.split("?")[0]!)) return isSettingsPath(pathname);
  const [hrefPath, hrefQuery = ""] = href.split("?");
  if (hrefPath !== pathname) return false;
  const hrefDecision = new URLSearchParams(hrefQuery).get("decision");
  return hrefDecision === search.get("decision");
}

/** Flat list of every navigable destination, Overview first — what the command palette searches. */
export const ALL_NAV_LINKS: Array<NavLink & { group: string }> = [
  { ...OVERVIEW_LINK, group: "Dashboard" },
  ...NAV_GROUPS.flatMap((group) =>
    group.links.filter((link) => link !== SETTINGS_LINK).map((link) => ({ ...link, group: group.label })),
  ),
  // No longer in the sidebar one by one, but still a keystroke away in the command palette, and the
  // breadcrumb reads "Settings > AI Providers" rather than nothing.
  ...SETTINGS_SECTIONS.flatMap((section) => section.links.map((link) => ({ ...link, group: "Settings" }))),
];

/**
 * Best-effort "where am I" for the header, by longest matching nav path. Detail routes
 * (`/rules/42/edit`) have no nav entry of their own, so they resolve to their closest
 * ancestor (`/rules`) rather than showing nothing.
 */
export function resolveNavLocation(pathname: string, search: URLSearchParams) {
  let best: (NavLink & { group: string }) | null = null;
  let bestLength = -1;

  for (const link of ALL_NAV_LINKS) {
    const [linkPath] = link.href.split("?");
    const isExact = isNavActive(pathname, search, link.href);
    const isAncestor = pathname === linkPath || pathname.startsWith(`${linkPath}/`);
    if (!isExact && !isAncestor) continue;

    // An exact match (query string included) always beats a mere path ancestor, so
    // /messages?decision=IGNORE reports "Ignored Messages", not "All Messages".
    const score = isExact ? linkPath.length + 1000 : linkPath.length;
    if (score > bestLength) {
      best = link;
      bestLength = score;
    }
  }

  return best;
}
