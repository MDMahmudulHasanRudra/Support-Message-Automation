import {
  Activity,
  AlertCircle,
  BarChart3,
  Bell,
  BookOpen,
  ClipboardCheck,
  ClipboardList,
  Terminal as ConsoleIcon,
  Cpu,
  EyeOff,
  Fingerprint,
  FlaskConical,
  History,
  KeyRound,
  LayoutDashboard,
  Link2,
  ListChecks,
  MessagesSquare,
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
  Waypoints,
  UserPlus,
  UserCog,
  Users,
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
}

// The one always-visible landing page — pinned above the scrollable groups below rather than
// living inside a redundant single-item group of its own.
export const OVERVIEW_LINK: NavLink = { href: "/overview", label: "Overview", icon: LayoutDashboard };

// Ordered for day-to-day frequency: live/operational areas checked constantly (messages,
// escalations, team activity) first, setup/config areas checked occasionally next, advanced
// analytical modules and system admin — checked rarely — last.
export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Messages",
    links: [
      { href: "/messages", label: "All Messages", icon: MessagesSquare },
      { href: "/messages?decision=SUPPORT_REQUIRED", label: "Needs Attention", icon: AlertCircle },
      { href: "/messages?decision=IGNORE", label: "Ignored Messages", icon: EyeOff },
    ],
  },
  {
    label: "Escalations",
    links: [
      { href: "/support-escalation", label: "Active Cases", icon: ShieldAlert },
      { href: "/support-escalation/policies", label: "Policies", icon: SlidersHorizontal },
    ],
  },
  {
    label: "Support Activity",
    links: [
      { href: "/support-activity", label: "Activity", icon: Activity },
      { href: "/support-activity/team", label: "Team Performance", icon: Users },
      { href: "/support-activity/reports", label: "Reports", icon: BarChart3 },
      { href: "/support-activity/rules", label: "Rules", icon: ClipboardList },
      { href: "/support-activity/keywords", label: "Keywords", icon: Tag },
      { href: "/support-activity/settings", label: "Settings", icon: SettingsIcon },
    ],
  },
  {
    label: "Teams Integration",
    links: [
      { href: "/issues", label: "Issues", icon: Link2 },
      { href: "/integrations/teams", label: "Connection", icon: Link2 },
      { href: "/integrations/teams/manage", label: "Manage Teams & Channels", icon: Users },
      { href: "/integrations/teams/rules", label: "Resolution Rules", icon: ClipboardList },
      { href: "/integrations/teams/keywords", label: "Resolution Keywords", icon: Tag },
      { href: "/integrations/teams/settings", label: "Settings", icon: SettingsIcon },
    ],
  },
  {
    label: "WhatsApp",
    links: [
      { href: "/accounts", label: "WhatsApp Accounts", icon: Smartphone },
      { href: "/accounts/routing", label: "Account Routing", icon: Route },
      { href: "/groups", label: "Groups", icon: Users },
      { href: "/team-members", label: "Internal Team Members", icon: UserCog },
    ],
  },
  {
    label: "Automation",
    links: [
      { href: "/rules", label: "Automation Rules", icon: ListChecks },
      { href: "/rules/tester", label: "Rule Tester", icon: FlaskConical },
      { href: "/automation-control", label: "Automation Control", icon: Power },
    ],
  },
  {
    label: "Bulk Messaging",
    links: [
      { href: "/group-message-sender", label: "Group Message Sender", icon: Send },
      { href: "/group-message-sender/history", label: "Broadcast History", icon: History },
      { href: "/group-member-adder", label: "Add Number to Groups", icon: UserPlus },
    ],
  },
  {
    label: "AI Learning",
    links: [
      { href: "/ai-learning", label: "Overview", icon: Sparkles },
      { href: "/ai-learning/knowledge-base", label: "Knowledge Base", icon: BookOpen },
      { href: "/ai-learning/providers", label: "AI Providers", icon: KeyRound },
      { href: "/ai-learning/models", label: "AI Models", icon: Cpu },
      { href: "/ai-learning/settings", label: "AI Settings", icon: SettingsIcon },
    ],
  },
  {
    label: "Conversation Learning",
    links: [
      { href: "/conversation-learning", label: "Overview", icon: Waypoints },
      { href: "/conversation-learning/pattern-candidates", label: "Pattern Candidates", icon: Fingerprint },
      { href: "/conversation-learning/unknown-patterns", label: "Unknown Patterns", icon: EyeOff },
      { href: "/conversation-learning/rule-proposals", label: "Rule Proposals", icon: ClipboardCheck },
      { href: "/conversation-learning/settings", label: "Conversation Settings", icon: SettingsIcon },
    ],
  },
  {
    label: "System",
    links: [
      { href: "/notifications", label: "Notifications", icon: Bell },
      { href: "/settings", label: "Settings", icon: SettingsIcon },
      { href: "/logs", label: "System Logs", icon: ConsoleIcon },
    ],
  },
  {
    label: "Users & Permissions",
    links: [
      { href: "/users", label: "App Users", icon: UserCog },
      { href: "/permissions", label: "Permission Modules", icon: ShieldCheck },
      { href: "/settings/security", label: "Security Settings", icon: SlidersHorizontal },
    ],
  },
];

export function isNavActive(pathname: string, search: URLSearchParams, href: string) {
  const [hrefPath, hrefQuery = ""] = href.split("?");
  if (hrefPath !== pathname) return false;
  const hrefDecision = new URLSearchParams(hrefQuery).get("decision");
  return hrefDecision === search.get("decision");
}

/** Flat list of every navigable destination, Overview first — what the command palette searches. */
export const ALL_NAV_LINKS: Array<NavLink & { group: string }> = [
  { ...OVERVIEW_LINK, group: "Dashboard" },
  ...NAV_GROUPS.flatMap((group) => group.links.map((link) => ({ ...link, group: group.label }))),
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
