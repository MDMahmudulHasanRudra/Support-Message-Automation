import { pathAllowedByFeatures, REPORT_CATALOGUE, type ReportCategory, type ReportExportFormat } from "@support-automation/shared";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  BarChart3,
  Bell,
  BellRing,
  BookOpen,
  CalendarClock,
  CalendarDays,
  Camera,
  Globe,
  KanbanSquare,
  Package,
  ShoppingCart,
  Truck,
  Store,
  Webhook,
  CheckCheck,
  Images,
  Rss,
  Flag,
  Share2,
  FileText,
  CalendarRange,
  PenSquare,
  ClipboardCheck,
  ClipboardList,
  Clock,
  Contact,
  Cpu,
  CreditCard,
  EyeOff,
  FileEdit,
  FileSpreadsheet,
  FileUp,
  Fingerprint,
  FlaskConical,
  Gauge,
  GraduationCap,
  Grid3x3,
  HardDrive,
  History,
  Hourglass,
  Inbox,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  ListTodo,
  Mail,
  Megaphone,
  MessageCircleMore,
  MessageSquareOff,
  MessageSquareQuote,
  MessagesSquare,
  Network,
  PackageSearch,
  PhoneCall,
  PieChart,
  PlugZap,
  Power,
  ReceiptText,
  Route,
  Send,
  Settings as SettingsIcon,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Smile,
  Sparkles,
  Terminal as ConsoleIcon,
  Timer,
  TrendingUp,
  UserCheck,
  UserCog,
  UserPlus,
  Users,
  UsersRound,
  Wallet,
  Waypoints,
  type LucideIcon,
} from "lucide-react";

/** No project features switched off — the default for every caller that does not pass a set. */
const NO_FEATURES_OFF: ReadonlySet<string> = new Set();

/**
 * Which pages a member's project role opens (projectSections.ts), or undefined when no page selection
 * applies — every global role, every Lead, every role saved before pages existed. Presentation only:
 * the page and its actions check again (server/permissions.ts).
 */
export type PageFilter = ((href: string) => boolean) | undefined;

/**
 * The single source of truth for dashboard navigation. Lives outside Sidebar.tsx
 * because three things now read it — the sidebar, the ⌘K command palette, and the
 * header's location label — and a second copy would drift the moment a link moved.
 */

export interface NavLink {
  href: string;
  label: string;
  icon: LucideIcon;
  /**
   * Pages that share this ONE sidebar entry, shown as tabs across the top of each of them (see
   * SubNavTabs). The entry's own page is normally the first tab. Every tab keeps its own route,
   * page and permission — this is navigation only, no page was merged. A role sees the entry if it
   * can open any tab, and the entry opens the first tab it can.
   */
  tabs?: NavLink[];
}

/**
 * One top-level module in the sidebar: a collapsible parent whose children are its links.
 *
 * The sidebar used to draw every group fully expanded under four department headings — about fifty
 * rows, most of them irrelevant to whatever the reader was doing. Now only the parent holding the
 * current page opens by itself; the rest stay one line each until opened (and stay open if the reader
 * opens them). A group with a single link renders as that link directly, with no parent row.
 */
export interface NavGroup {
  label: string;
  icon: LucideIcon;
  links: NavLink[];
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
    description: "Which number sends each kind of notification, and what media is kept.",
    links: [
      { href: "/accounts/routing", label: "Account Routing", icon: Route },
      { href: "/settings/media-storage", label: "Message & Media Storage", icon: HardDrive },
    ],
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
    description: "Escalation timers, what counts as support work, and upset customers.",
    links: [
      { href: "/support-escalation/policies", label: "Escalation Policies", icon: ShieldAlert },
      { href: "/support-activity/settings", label: "Support Activity Setup", icon: Activity },
      { href: "/settings/mood-detection", label: "Mood Detection", icon: Smile },
      { href: "/support-assignment/settings", label: "Support Assignment", icon: ListTodo },
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
    label: "Messaging Channels",
    description: "Facebook Messenger, Instagram DM and Telegram connections, their webhooks and whether AI answers on them.",
    links: [{ href: "/settings/channels", label: "Messaging Channels", icon: PlugZap }],
  },
  {
    label: "Clients",
    description: "Which parts of Client Management this project uses, which fields are required, and the renewal window.",
    links: [{ href: "/settings/clients", label: "Client Module", icon: Contact }],
  },
  {
    label: "Email",
    description: "The SMTP mail server this project's email leaves from, and a test message to confirm it works.",
    links: [{ href: "/settings/email", label: "Email", icon: Mail }],
  },
  {
    label: "Commerce",
    description: "The couriers parcels are booked with, and the online shops products and orders are imported from.",
    links: [
      { href: "/settings/couriers", label: "Couriers", icon: Truck },
      { href: "/settings/woocommerce", label: "WooCommerce", icon: Store },
      { href: "/settings/shopify", label: "Shopify", icon: Store },
    ],
  },
  {
    label: "Social Studio",
    description: "Whether social publishing is set up on this server, and what Social Studio connects with.",
    links: [{ href: "/settings/social", label: "Social Publishing", icon: Megaphone }],
  },
  {
    label: "Integrations",
    description: "API keys for your own systems and signed webhooks to them.",
    links: [{ href: "/settings/api", label: "API & Webhooks", icon: Webhook }],
  },
  {
    label: "Google Sheets",
    description: "The Google accounts this project's spreadsheets are reached through, and how work time is measured.",
    links: [{ href: "/settings/google-sheets", label: "Google Accounts", icon: FileSpreadsheet }],
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

/**
 * Whether a link is offered: the role holds the page's key AND the project is entitled to the
 * feature the page belongs to (MULTI_PROJECT_PLAN.md §9). Presentation only — the page and its
 * actions make both checks themselves.
 */
function canOffer(href: string, granted: ReadonlySet<string>, disabledFeatures: ReadonlySet<string>, pages?: PageFilter): boolean {
  const key = navPermissionFor(href);
  return (key === null || granted.has(key)) && pathAllowedByFeatures(href, disabledFeatures) && (pages === undefined || pages(href));
}

/** The Settings sections reduced to the pages this role can open. Empty sections are dropped. */
export function settingsSectionsFor(
  granted: ReadonlySet<string>,
  disabledFeatures: ReadonlySet<string> = NO_FEATURES_OFF,
  pages?: PageFilter,
): SettingsSection[] {
  return SETTINGS_SECTIONS.map((section) => ({
    ...section,
    links: section.links.filter((link) => canOffer(link.href, granted, disabledFeatures, pages)),
  })).filter((section) => section.links.length > 0);
}

/**
 * Every report, reached from one "All Reports" page instead of a link at the end of each module.
 *
 * Reports were split by the module that produced them — Support Activity's Reports under one group,
 * Team Management's Duty History under another — so somebody looking for "the report" had to know
 * which department owned it. The pages did not move; `/reports` lists them as cards, and the one
 * sidebar entry stays lit while either is open. Add a report here, not at the end of its module.
 */
export interface ReportPage extends NavLink {
  /** The module that produces it, shown on its card. */
  module: string;
  description: string;
  /** From the shared report catalogue (packages/shared/src/reportCatalogue.ts). */
  category: ReportCategory;
  question: string;
  exports: readonly ReportExportFormat[];
}

/** The icon and producing module of each catalogue report — the only parts that are web-only. */
const REPORT_PRESENTATION: Record<string, { icon: LucideIcon; module: string }> = {
  "team-report": { icon: ClipboardCheck, module: "WhatsApp support" },
  "support-activity": { icon: Activity, module: "Support Activity" },
  "support-assignment": { icon: ListTodo, module: "Support Assignment" },
  "duty-history": { icon: CalendarDays, module: "Team Management" },
  "employee-groups": { icon: UsersRound, module: "WhatsApp support" },
  "whatsapp-user-activity": { icon: MessageCircleMore, module: "WhatsApp Chat" },
  "duty-workload": { icon: CalendarClock, module: "Team Management" },
  "executive-health": { icon: Activity, module: "WhatsApp support" },
  "support-intelligence": { icon: Activity, module: "Support Intelligence" },
  "employee-effectiveness": { icon: UsersRound, module: "Support Intelligence" },
  "support-cases": { icon: ClipboardCheck, module: "Support Intelligence" },
  "human-response-sla": { icon: Timer, module: "Support Intelligence" },
  "customer-signals": { icon: ShieldCheck, module: "Support Intelligence" },
  "inactive-groups": { icon: MessageSquareOff, module: "WhatsApp support" },
  "group-coverage": { icon: ShieldCheck, module: "WhatsApp support" },
  "group-trend": { icon: TrendingUp, module: "WhatsApp support" },
  "response-sla": { icon: Timer, module: "WhatsApp support" },
  missed: { icon: AlertTriangle, module: "WhatsApp support" },
  workload: { icon: Gauge, module: "WhatsApp support" },
  heatmap: { icon: Grid3x3, module: "WhatsApp support" },
  calls: { icon: PhoneCall, module: "WhatsApp support" },
  distribution: { icon: PieChart, module: "WhatsApp support" },
};

export const REPORT_PAGES: ReportPage[] = REPORT_CATALOGUE.map((entry) => ({
  href: entry.href,
  label: entry.label,
  description: entry.description,
  category: entry.category,
  question: entry.question,
  exports: entry.exports,
  icon: REPORT_PRESENTATION[entry.id]?.icon ?? BarChart3,
  module: REPORT_PRESENTATION[entry.id]?.module ?? "Reports",
}));

export const REPORTS_LINK: NavLink = { href: "/reports", label: "All Reports", icon: BarChart3 };

/** Team Report is also a sidebar entry of its own, so it is excluded from lighting "All Reports". */
export const TEAM_REPORT_LINK: NavLink = { href: "/team-report", label: "Team Report", icon: ClipboardCheck };

/** Whether a path is the reports hub or one of the reports it lists (or anything beneath one). */
export function isReportPath(pathname: string): boolean {
  if (pathname === REPORTS_LINK.href) return true;
  return REPORT_PAGES.some((page) => pathname === page.href || pathname.startsWith(`${page.href}/`));
}

/** The reports this role can open. */
export function reportPagesFor(granted: ReadonlySet<string>, disabledFeatures: ReadonlySet<string> = NO_FEATURES_OFF, pages?: PageFilter): ReportPage[] {
  return REPORT_PAGES.filter((page) => canOffer(page.href, granted, disabledFeatures, pages));
}

// Ordered for day-to-day frequency: live/operational areas checked constantly (messages,
// escalations, team activity) first, setup/config areas checked occasionally next, advanced
// analytical modules and system admin — checked rarely — last.
export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Support",
    icon: MessageCircleMore,
    links: [
      // The unified inbox and the channel inboxes beside WhatsApp (OMNICHANNEL.md). The Omnichannel
      // feature hides all four when it is off; WhatsApp Chat is unaffected either way.
      { href: "/conversations/all", label: "All Conversations", icon: Inbox },
      { href: "/chat", label: "WhatsApp Chat", icon: MessageCircleMore },
      { href: "/conversations/messenger", label: "Facebook Messenger", icon: MessagesSquare },
      { href: "/conversations/instagram", label: "Instagram DM", icon: Camera },
      { href: "/conversations/telegram", label: "Telegram", icon: Send },
      { href: "/conversations/website", label: "Website Chat", icon: Globe },
      {
        href: "/messages",
        label: "Messages",
        icon: MessagesSquare,
        tabs: [
          { href: "/messages", label: "All messages", icon: MessagesSquare },
          { href: "/messages?decision=SUPPORT_REQUIRED", label: "Needs attention", icon: AlertCircle },
          { href: "/messages?decision=IGNORE", label: "Ignored", icon: EyeOff },
          { href: "/messages/unanswered", label: "Unanswered groups", icon: Hourglass },
          { href: "/messages/response-time", label: "Response time", icon: Timer },
        ],
      },
      {
        href: "/support-assignment/unanswered",
        label: "Support Assignment",
        icon: ListTodo,
        tabs: [
          { href: "/support-assignment/unanswered", label: "Unanswered", icon: ListTodo },
          { href: "/support-assignment/mine", label: "My assignments", icon: UserCheck },
          { href: "/support-assignment/completed", label: "Completed", icon: CheckCheck },
          { href: "/support-assignment/report", label: "Report", icon: BarChart3 },
        ],
      },
      { href: "/support-escalation", label: "Escalations", icon: ShieldAlert },
    ],
  },
  {
    // Client Management (CLIENT_CENTER.md): the one client database. A project feature that ships off.
    label: "Clients",
    icon: Contact,
    links: [
      { href: "/clients", label: "All Clients", icon: Contact },
      { href: "/clients/subscriptions", label: "Subscriptions", icon: CalendarClock },
      // The route is still /clients/dues (bookmarks keep working); the page is the Billing List now.
      { href: "/clients/dues", label: "Billing List", icon: ReceiptText },
      { href: "/clients/payments", label: "Payments & Receipts", icon: Wallet },
      { href: "/clients/import", label: "Import Clients", icon: FileUp },
    ],
  },
  {
    // Commerce (COMMERCE.md): catalogue and stock, orders, the sales pipeline. Each is its own project
    // feature, off by default and on for the E-commerce business type.
    label: "Commerce",
    icon: ShoppingCart,
    links: [
      { href: "/commerce/orders", label: "Orders", icon: ShoppingCart },
      { href: "/commerce/products", label: "Products", icon: Package },
      { href: "/commerce/shipments", label: "Shipments", icon: Truck },
      { href: "/sales", label: "Sales Pipeline", icon: KanbanSquare },
    ],
  },
  {
    // Social Studio (SOCIAL_STUDIO.md): Get Assist's own social publishing. Its own project feature,
    // off by default and never switched on by a plan.
    label: "Social Studio",
    icon: Megaphone,
    links: [
      { href: "/social", label: "Overview", icon: Megaphone },
      { href: "/social/calendar", label: "Calendar", icon: CalendarRange },
      {
        href: "/social/posts",
        label: "Posts",
        icon: PenSquare,
        tabs: [
          { href: "/social/posts?view=drafts", label: "Drafts", icon: PenSquare },
          { href: "/social/posts?view=approvals", label: "Approvals", icon: CheckCheck },
          { href: "/social/posts?view=scheduled", label: "Scheduled", icon: CalendarRange },
          { href: "/social/posts?view=published", label: "Published", icon: Megaphone },
          { href: "/social/posts?view=failed", label: "Failed", icon: AlertTriangle },
          { href: "/social/posts?view=all", label: "All", icon: FileText },
        ],
      },
      { href: "/social/media", label: "Media Library", icon: Images },
      { href: "/social/campaigns", label: "Campaigns", icon: Flag },
      { href: "/social/templates", label: "Templates", icon: FileText },
      { href: "/social/analytics", label: "Analytics", icon: BarChart3 },
      { href: "/social/ai", label: "AI Content", icon: Sparkles },
      { href: "/social/automation", label: "Automation", icon: Rss },
      { href: "/social/accounts", label: "Accounts", icon: Share2 },
    ],
  },
  {
    // Support Activity's two people-pages joined Team Management's three: both answer "what is the
    // team doing" — one from the schedule, one from the messages.
    label: "Team",
    icon: Users,
    links: [
      { href: "/team-management", label: "Today", icon: Users },
      { href: "/team-management/schedule", label: "Roster", icon: CalendarDays },
      { href: "/team-management/leave", label: "Leave", icon: ClipboardList },
      { href: "/support-activity/team", label: "Team Performance", icon: Gauge },
      { href: "/support-activity", label: "Activity Feed", icon: Activity },
    ],
  },
  {
    label: "Reports",
    icon: BarChart3,
    links: [TEAM_REPORT_LINK, REPORTS_LINK],
  },
  {
    // Bulk Messaging lives here now: broadcasting to groups and adding a number to groups are
    // WhatsApp work done with the same accounts and the same groups listed right above them.
    label: "WhatsApp",
    icon: Smartphone,
    links: [
      { href: "/accounts", label: "Accounts", icon: Smartphone },
      { href: "/groups", label: "Groups", icon: Users },
      { href: "/team-members", label: "Team Members", icon: UserCog },
      { href: "/teams", label: "Teams", icon: Network },
      {
        href: "/group-message-sender",
        label: "Broadcast",
        icon: Send,
        tabs: [
          { href: "/group-message-sender", label: "New broadcast", icon: Send },
          { href: "/group-message-sender/history", label: "Broadcast history", icon: History },
        ],
      },
      { href: "/group-member-adder", label: "Add Number to Groups", icon: UserPlus },
      { href: "/group-admin-maker", label: "Groups Admin Maker", icon: UserCog },
    ],
  },
  {
    // GOOGLE_SHEETS.md. Its account connections and settings live under Settings → Google Sheets.
    label: "Google Sheets",
    icon: FileSpreadsheet,
    links: [
      { href: "/google-sheets", label: "Spreadsheets", icon: FileSpreadsheet },
      { href: "/google-sheets/activity", label: "Activity", icon: Activity },
      { href: "/google-sheets/reports", label: "Work Reports", icon: BarChart3 },
      { href: "/google-sheets/identity", label: "My Google Identity", icon: Fingerprint },
    ],
  },
  {
    label: "Automation",
    icon: ListChecks,
    links: [
      {
        href: "/rules",
        label: "Automation Rules",
        icon: ListChecks,
        tabs: [
          { href: "/rules", label: "Rules", icon: ListChecks },
          { href: "/rules/tester", label: "Rule Tester", icon: FlaskConical },
        ],
      },
      { href: "/automation-control", label: "Automation Control", icon: Power },
    ],
  },
  {
    label: "AI Learning",
    icon: Sparkles,
    links: [
      { href: "/ai-learning", label: "Overview", icon: Sparkles },
      { href: "/ai-learning/activity", label: "AI Activity", icon: Gauge },
      {
        href: "/ai-learning/knowledge-base",
        label: "Knowledge Base",
        icon: BookOpen,
        tabs: [
          { href: "/ai-learning/knowledge-base", label: "Entries", icon: BookOpen },
          { href: "/ai-learning/knowledge-base/review", label: "Pending review", icon: ClipboardCheck },
          { href: "/ai-learning/knowledge-base/import", label: "Import", icon: FileUp },
        ],
      },
      { href: "/ai-learning/communication-style", label: "Communication Style", icon: MessageSquareQuote },
    ],
  },
  {
    label: "Conversation Learning",
    icon: Waypoints,
    links: [
      { href: "/conversation-learning", label: "Overview", icon: Waypoints },
      { href: "/conversation-learning/sandbox", label: "AI Sandbox", icon: FlaskConical },
      { href: "/conversation-learning/knowledge-builder", label: "Knowledge Builder", icon: GraduationCap },
      {
        href: "/conversation-learning/pattern-candidates",
        label: "Patterns",
        icon: Fingerprint,
        tabs: [
          { href: "/conversation-learning/pattern-candidates", label: "Pattern candidates", icon: Fingerprint },
          { href: "/conversation-learning/unknown-patterns", label: "Unknown patterns", icon: EyeOff },
        ],
      },
      { href: "/conversation-learning/rule-proposals", label: "Rule Proposals", icon: ClipboardCheck },
    ],
  },
  {
    label: "System",
    icon: ConsoleIcon,
    links: [
      { href: "/notifications", label: "Notifications", icon: Bell },
      { href: "/logs", label: "System Logs", icon: ConsoleIcon },
      SETTINGS_LINK,
    ],
  },
  {
    // Logins and roles of the whole installation — the same in every project. In the Main Admin
    // Workspace this group sits under Main Admin → Users & Permissions (DashboardShell), not here.
    label: "Users & Permissions",
    icon: ShieldCheck,
    links: [
      { href: "/users", label: "App Users", icon: UserCog },
      { href: "/permissions", label: "Permission Modules", icon: ShieldCheck },
    ],
  },
  {
    // This project's own administration (PROJECT_ROLES.md): its Lead's pages, and a Main Admin's.
    label: "Project Users & Permissions",
    icon: UsersRound,
    links: [
      { href: "/project-members", label: "Project Members", icon: UsersRound },
      { href: "/project-roles", label: "Project Roles", icon: KeyRound },
      // SaaS (SAAS_PLATFORM_PLAN.md section 10.5): the owner's view of their own plan and payments.
      { href: "/subscription", label: "Subscription", icon: CreditCard },
    ],
  },
  {
    label: "Release Notes",
    icon: Megaphone,
    links: [
      {
        href: "/release-notes",
        label: "Release Notes",
        icon: Megaphone,
        tabs: [
          { href: "/release-notes", label: "Release notes", icon: Megaphone },
          { href: "/release-notes/manage", label: "Manage releases", icon: FileEdit },
        ],
      },
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
  // Shows message text, so it needs the chat's key rather than the other reports' support_activity.view.
  "/reports/whatsapp-user-activity": "messages.view",
};

/** Longest prefix wins, so `/ai-learning/providers` resolves before `/ai-learning`. */
const NAV_KEY_PREFIX: Array<[string, string]> = [
  ["/chat", "messages.view"],
  ["/clients/dues", "clients.view_billing"],
  ["/clients/payments", "clients.view_billing"],
  ["/clients/import", "clients.import"],
  ["/clients/new", "clients.create"],
  ["/clients", "clients.view"],
  ["/commerce/products/new", "commerce.manage"],
  ["/commerce/products", "commerce.view"],
  ["/commerce/orders/new", "orders.manage"],
  ["/commerce/orders", "orders.view"],
  ["/sales/new", "sales.manage"],
  ["/commerce/shipments", "shipments.view"],
  ["/settings/couriers", "shipments.view"],
  ["/settings/woocommerce", "woocommerce.manage"],
  ["/settings/shopify", "shopify.manage"],
  ["/settings/api", "api.manage"],
  ["/settings/social", "social.manage"],
  ["/social/new", "social.edit"],
  ["/social", "social.view"],
  ["/sales", "sales.view"],
  ["/messages", "messages.view"],
  ["/support-escalation", "escalations.view"],
  ["/support-activity", "support_activity.view"],
  ["/support-assignment", "support_assignment.view"],
  ["/team-report", "support_activity.view"],
  // The reports at /reports/<id> (REPORTS.md): the Team Report's key, and Duty History's for duty.
  ...REPORT_CATALOGUE.filter((r) => r.generic).map(
    (r) => [r.href, r.id === "duty-workload" ? "team_management.view" : "support_activity.view"] as [string, string],
  ),
  ["/team-management", "team_management.view"],
  ["/accounts", "whatsapp.view"],
  ["/groups", "whatsapp.view"],
  ["/team-members", "whatsapp.view"],
  ["/teams", "whatsapp.view"],
  ["/rules", "automation_rules.view"],
  ["/automation-control", "settings.view"],
  ["/group-message-sender", "bulk_messaging.view"],
  ["/group-member-adder", "bulk_messaging.view"],
  ["/group-admin-maker", "bulk_messaging.view"],
  ["/ai-learning/providers", "ai_settings.view"],
  ["/ai-learning/models", "ai_settings.view"],
  ["/ai-learning/settings", "ai_settings.view"],
  ["/ai-learning", "ai_learning.view"],
  ["/integrations/forge", "ai_learning.view"],
  ["/conversation-learning", "conversation_learning.view"],
  ["/notifications", "notifications.view"],
  ["/settings/security", "security_settings.view"],
  ["/settings/google-sheets", "google_sheets.view"],
  ["/settings/channels", "channels.view"],
  ["/settings/email", "communications.manage_email"],
  ["/settings/clients", "clients.manage_settings"],
  ["/conversations", "messages.view"],
  ["/google-sheets/activity", "google_sheets.monitor"],
  ["/google-sheets/reports", "google_sheets.report"],
  ["/google-sheets", "google_sheets.view"],
  ["/settings", "settings.view"],
  ["/logs", "system_logs.view"],
  ["/users", "users.view"],
  ["/permissions", "permissions.view"],
  ["/project-members", "project_members.manage"],
  ["/project-roles", "project_roles.manage"],
  ["/subscription", "project_members.manage"],
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
export function navGroupsFor(granted: ReadonlySet<string>, disabledFeatures: ReadonlySet<string> = NO_FEATURES_OFF, pages?: PageFilter): NavGroup[] {
  // Settings is shown whenever the role can open ANY settings page, and opens the first one it can:
  // a role with AI access but no general settings access must still find its way to AI Settings.
  const firstSettingsPage = settingsSectionsFor(granted, disabledFeatures, pages)[0]?.links[0] ?? null;
  const canOpenAnyReport = reportPagesFor(granted, disabledFeatures, pages).length > 0;
  return NAV_GROUPS.map((group) => ({
    ...group,
    links: group.links.flatMap((link) => {
      if (link === SETTINGS_LINK) return firstSettingsPage ? [{ ...SETTINGS_LINK, href: firstSettingsPage.href }] : [];
      if (link === REPORTS_LINK) return canOpenAnyReport ? [link] : [];
      const permitted = (candidate: NavLink) => canOffer(candidate.href, granted, disabledFeatures, pages);
      if (link.tabs) {
        // Shown when ANY tab opens for this role, pointing at the first one that does — a role
        // that can read Broadcast history but not send one still finds its way in.
        const tabs = link.tabs.filter(permitted);
        return tabs.length ? [{ ...link, href: tabs[0]!.href, tabs }] : [];
      }
      return permitted(link) ? [link] : [];
    }),
  })).filter((group) => group.links.length > 0);
}

export function isNavActive(pathname: string, search: URLSearchParams, href: string, label?: string) {
  // The one Settings entry stands for the whole module, so it stays lit on every settings page.
  if (label === SETTINGS_LINK.label && isSettingsPath(href.split("?")[0]!)) return isSettingsPath(pathname);
  if (href === REPORTS_LINK.href) {
    const onTeamReport = pathname === TEAM_REPORT_LINK.href || pathname.startsWith(`${TEAM_REPORT_LINK.href}/`);
    return isReportPath(pathname) && !onTeamReport;
  }
  const [hrefPath, hrefQuery = ""] = href.split("?");
  if (hrefPath !== pathname) return false;
  const hrefDecision = new URLSearchParams(hrefQuery).get("decision");
  return hrefDecision === search.get("decision");
}

/** Whether a location is on one tab: its exact page (query included), or a detail page beneath it. */
function onTab(pathname: string, search: URLSearchParams, tabHref: string): boolean {
  if (isNavActive(pathname, search, tabHref)) return true;
  const [tabPath, tabQuery] = tabHref.split("?");
  return !tabQuery && pathname.startsWith(`${tabPath}/`);
}

/**
 * The tab a location belongs to within one tab set — the LONGEST match, so the Knowledge Base
 * import page lights "Import" rather than "Entries", whose path it also sits under.
 */
export function activeTabHref(pathname: string, search: URLSearchParams, tabs: readonly NavLink[]): string | null {
  const exact = tabs.find((tab) => isNavActive(pathname, search, tab.href));
  if (exact) return exact.href;
  const ancestors = tabs.filter((tab) => onTab(pathname, search, tab.href));
  ancestors.sort((a, b) => b.href.length - a.href.length);
  return ancestors[0]?.href ?? null;
}

/** Whether a sidebar entry is the current page — for an entry with tabs, whether any tab is. */
export function isLinkActive(pathname: string, search: URLSearchParams, link: NavLink): boolean {
  if (link.tabs) return activeTabHref(pathname, search, link.tabs) !== null;
  return isNavActive(pathname, search, link.href, link.label);
}

/** Whether a location is anywhere inside a group — decides which parent opens by itself. */
export function isGroupActive(pathname: string, search: URLSearchParams, group: NavGroup): boolean {
  // A settings page or report (/support-activity/settings, /team-management/attendance) sits under
  // another module's path but belongs to System or Reports, whose links light for it — without this,
  // Team would open beside them.
  const ownedElsewhere = isSettingsPath(pathname) || isReportPath(pathname);
  return group.links.some((link) => {
    if (isLinkActive(pathname, search, link)) return true;
    // Detail pages beneath an entry (/rules/42/edit) belong to its group even when the entry itself
    // is not lit because another entry is a longer match.
    const [path, query] = link.href.split("?");
    if (ownedElsewhere && !isSettingsPath(path!) && !isReportPath(path!)) return false;
    return !query && link.href !== OVERVIEW_LINK.href && pathname.startsWith(`${path}/`);
  });
}

/** The tab strip for the current location, if it is on a page that shares an entry. */
export function tabsForLocation(
  pathname: string,
  search: URLSearchParams,
  groups: readonly NavGroup[],
): { tabs: NavLink[]; activeHref: string | null } | null {
  for (const group of groups) {
    for (const link of group.links) {
      if (!link.tabs || link.tabs.length < 2) continue;
      const activeHref = activeTabHref(pathname, search, link.tabs);
      if (activeHref) return { tabs: link.tabs, activeHref };
    }
  }
  return null;
}

/** Flat list of every navigable destination, Overview first — what the command palette searches. */
export const ALL_NAV_LINKS: Array<NavLink & { group: string }> = [
  { ...OVERVIEW_LINK, group: "Dashboard" },
  // Tabs are expanded into their own entries, so searching "Rule Tester" or "Pending review" still
  // lands on that exact page, and the breadcrumb names the page rather than the shared entry.
  ...NAV_GROUPS.flatMap((group) =>
    group.links
      .filter((link) => link !== SETTINGS_LINK)
      .flatMap((link) => (link.tabs ?? [link]).map(({ href, label, icon }) => ({ href, label, icon, group: group.label }))),
  ),
  // No longer in the sidebar one by one, but still a keystroke away in the command palette, and the
  // breadcrumb reads "Settings > AI Providers" rather than nothing.
  ...SETTINGS_SECTIONS.flatMap((section) => section.links.map((link) => ({ ...link, group: "Settings" }))),
  ...REPORT_PAGES.filter((page) => page.href !== TEAM_REPORT_LINK.href).map(({ href, label, icon }) => ({
    href,
    label,
    icon,
    group: "Reports",
  })),
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
