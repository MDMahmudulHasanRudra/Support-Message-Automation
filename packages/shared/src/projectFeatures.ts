/**
 * The project feature catalogue (MULTI_PROJECT_PLAN.md §9).
 *
 * A feature is an ENTITLEMENT, decided by a Main Admin: whether this project may use a module at
 * all. The module's own settings (AiSettings.aiEngineEnabled, LearningSettings…) stay the project's
 * choice WITHIN that entitlement — both must be on for anything to happen.
 *
 * One check, four places, all reading this file:
 *   - the sidebar, ⌘K and the Settings/Reports hubs hide the feature's pages (`featureForPath`);
 *   - its pages refuse to open (the project layout and `requireAccess` / `pageAccess`);
 *   - its actions refuse (`checkPermission`, by page path and by the keys only it uses);
 *   - the worker skips its work at the points that already check the module's own setting.
 *
 * Storage is `ProjectFeature { projectId, key, enabled }`. An absent row means the default below —
 * the same shape as `NotificationEventSetting` — so adding a feature needs no migration and no
 * backfill, and ISP Digital (which has no rows) keeps every feature it has always had.
 *
 * Nothing here, or anywhere, compares a project's name or slug.
 */

export interface ProjectFeatureDefinition {
  key: string;
  label: string;
  description: string;
  defaultEnabled: boolean;
  /** Path prefixes, project-relative, of the pages (and export routes) that belong to this feature. */
  routes: readonly string[];
  /**
   * Permission keys used ONLY by this feature's pages and actions, so an action gated on one is this
   * feature's action wherever it is called from. Keys shared with another module are not listed —
   * those actions are gated by the page they are posted from, or by an explicit check in the action.
   */
  permissionKeys: readonly string[];
  /** What switching it off does in the background, for the Main Admin Portal to say plainly. */
  workerEffect: string;
  /**
   * Switched only by a person, never by a plan — not even "All Access" (WHATSAPP_AVATARS.md). For
   * a switch whose own approval is separate from the customer's package.
   */
  manualOnly?: boolean;
}

export const PROJECT_FEATURES = [
  {
    key: "WHATSAPP_CHAT",
    label: "WhatsApp Chat",
    description: "The shared inbox and replying from it.",
    defaultEnabled: true,
    routes: ["/chat"],
    permissionKeys: ["messages.reply"],
    workerEffect: "Nothing runs in the background for it. Messages are still collected and shown under Messages.",
  },
  {
    key: "AI_REPLY",
    label: "AI replies",
    description: "AI answers customers when no rule matches.",
    defaultEnabled: true,
    routes: ["/ai-learning/activity"],
    permissionKeys: [],
    workerEffect: "The AI fallback never answers or hands over; rules still run.",
  },
  {
    key: "AI_LEARNING",
    label: "AI Learning",
    description: "Knowledge base, imports and communication style.",
    defaultEnabled: true,
    routes: ["/ai-learning/knowledge-base", "/ai-learning/communication-style", "/api/knowledge"],
    permissionKeys: [],
    workerEffect: "Knowledge imports, learning knowledge from group chats and the communication-style rebuild stop.",
  },
  {
    key: "CONVERSATION_LEARNING",
    label: "Conversation Learning",
    description: "Pattern detection, rule proposals, the knowledge builder and the AI sandbox.",
    defaultEnabled: true,
    routes: ["/conversation-learning", "/api/sandbox"],
    permissionKeys: ["conversation_learning.view", "conversation_learning.manage"],
    workerEffect: "Session segmentation, pattern detection, AI analysis, the knowledge builder and sandbox replies stop.",
  },
  {
    key: "TEAM_MANAGEMENT",
    label: "Team Management",
    description: "Shifts, roster, leave, coverage and duty history.",
    defaultEnabled: true,
    routes: ["/team-management", "/api/team-management", "/reports/duty-workload", "/api/reports/duty-workload"],
    permissionKeys: ["team_management.view", "team_management.manage"],
    workerEffect: "Attendance is no longer recorded from messages.",
  },
  {
    key: "TEAM_REPORTS",
    label: "Team reports",
    description: "Team Report, Team Performance and the support reports built on the same messages.",
    defaultEnabled: true,
    routes: [
      "/team-report",
      "/support-activity/team",
      "/api/team-report",
      // The reports at /reports/<id> (REPORTS.md). Duty & Workload belongs to Team Management.
      "/reports/employee-groups",
      "/reports/inactive-groups",
      "/reports/executive-health", "/reports/support-intelligence", "/reports/employee-effectiveness", "/reports/support-cases", "/reports/human-response-sla", "/reports/customer-signals", "/reports/whatsapp-user-activity",
      "/reports/group-coverage",
      "/reports/group-trend",
      "/reports/response-sla",
      "/reports/missed",
      "/reports/workload",
      "/reports/heatmap",
      "/reports/calls",
      "/reports/distribution",
      "/api/reports",
    ],
    permissionKeys: [],
    workerEffect: "Nothing runs in the background for it; the reports read stored messages.",
  },
  {
    key: "BULK_MESSAGING",
    label: "Bulk messaging",
    description: "Broadcast, Add Number to Groups and Groups Admin Maker.",
    defaultEnabled: true,
    routes: ["/group-message-sender", "/group-member-adder", "/group-admin-maker"],
    permissionKeys: ["bulk_messaging.view", "bulk_messaging.manage"],
    workerEffect: "No new broadcast, add or admin-maker job can be started.",
  },
  {
    key: "ESCALATIONS",
    label: "Escalations",
    description: "Priority support SLA timers and alerts.",
    defaultEnabled: true,
    routes: ["/support-escalation"],
    permissionKeys: ["escalations.view", "escalations.manage"],
    workerEffect: "No escalation case is opened, and open cases stop advancing.",
  },
  {
    key: "SUPPORT_ASSIGNMENT",
    label: "Support Assignment",
    description: "Assigning unanswered customer waits to a person, with SLA, alerts and a report.",
    defaultEnabled: true,
    routes: ["/support-assignment", "/api/support-assignment"],
    permissionKeys: ["support_assignment.view", "support_assignment.assign", "support_assignment.manage"],
    workerEffect: "No case is opened or completed, and overdue and escalation alerts stop.",
  },
  {
    key: "SUPPORT_ACTIVITY",
    label: "Support Activity",
    description: "Support activity tracking, its feed and its report.",
    defaultEnabled: true,
    routes: ["/support-activity", "/api/support-activity"],
    permissionKeys: [],
    workerEffect: "Support activity is no longer recorded.",
  },
  {
    key: "PRODUCT_KNOWLEDGE_FORGE",
    label: "Product knowledge (Forge)",
    description: "Learning from the product's own repository through Forge.",
    defaultEnabled: true,
    routes: ["/integrations/forge"],
    permissionKeys: [],
    workerEffect: "The Forge sync, question research and live answer research stop.",
  },
  {
    key: "GOOGLE_SHEETS",
    label: "Google Sheets",
    description: "Connecting Google accounts, working on spreadsheets from the app, and tracking that work.",
    // Additive and new: no project gets it until a Main Admin switches it on.
    defaultEnabled: false,
    routes: ["/google-sheets", "/settings/google-sheets", "/api/google-sheets"],
    permissionKeys: ["google_sheets.view", "google_sheets.edit", "google_sheets.manage", "google_sheets.monitor", "google_sheets.report"],
    workerEffect: "Stops reading who changed monitored spreadsheets in Google directly. Connected accounts, sheets, members and their history are kept.",
  },
  {
    key: "OMNICHANNEL",
    label: "Omnichannel inbox",
    description: "All Conversations, plus Facebook Messenger, Instagram DM and Telegram alongside WhatsApp.",
    // Additive and new: no project gets it until a Main Admin switches it on. WhatsApp Chat is its
    // own feature and is unaffected either way.
    defaultEnabled: false,
    routes: ["/conversations", "/settings/channels"],
    permissionKeys: ["channels.view", "channels.manage", "conversations.reply"],
    workerEffect:
      "Messenger, Instagram and Telegram messages stop being processed and replies stop being sent; webhooks are still recorded so nothing is lost. Connections and conversation history are kept.",
  },
  {
    key: "CLIENT_CENTER",
    label: "Client Management",
    description: "One client database across every channel: contacts, channel references, tags, notes, import and export.",
    // New and unreleased: no project gets it until a Main Admin switches it on.
    defaultEnabled: false,
    routes: ["/clients", "/settings/email", "/settings/clients"],
    permissionKeys: ["clients.view", "clients.create", "clients.update", "clients.archive", "clients.delete", "clients.import", "clients.export", "clients.view_billing", "clients.edit_billing", "clients.link_whatsapp_chat", "clients.manage_subscriptions", "clients.link_whatsapp_group", "clients.manage_settings", "communications.manage_email"],
    workerEffect: "Nothing runs in the background for it. Switching it off hides the pages and refuses the actions; client records are kept.",
  },
  {
    key: "CHAT_UI_V2",
    label: "WhatsApp Chat — new conversation view",
    description:
      "The upgraded thread and composer (CHAT_UI_V2.md): older history, replies that quote, reactions, mentions, formatting, search in a conversation. Off = the current chat.",
    // A presentation switch, not a module: it owns no page and no key, so it never blocks anything.
    // Off for every project until a Main Admin switches it on; switching it off again is the
    // rollback, effective on the next page load, with no data to restore.
    defaultEnabled: false,
    routes: [],
    permissionKeys: [],
    workerEffect: "Nothing runs in the background for it. Replies already queued with a quote are still sent as replies.",
  },
  {
    key: "UNIFIED_REPORTING",
    label: "Unified messaging reports",
    description:
      "Team Report additions: personal-chat and combined scopes, run information, data-quality detail, customer-specific replies, and the identity-change impact preview. Off = the Team Report exactly as before.",
    // A presentation switch like CHAT_UI_V2: it owns no page and no key, so it never blocks a page.
    defaultEnabled: false,
    routes: [],
    permissionKeys: [],
    workerEffect: "Nothing runs in the background for it; the reports read stored messages.",
  },
  {
    key: "WHATSAPP_AVATARS",
    label: "WhatsApp profile pictures",
    description:
      "Shows the profile pictures and group icons WhatsApp already attaches to incoming messages, in WhatsApp Chat (WHATSAPP_AVATARS.md). Nothing is ever asked of WhatsApp to get one. Off = coloured initials, as before.",
    defaultEnabled: false,
    manualOnly: true,
    routes: [],
    permissionKeys: [],
    workerEffect:
      "Stops recording pictures from incoming messages and stops fetching them. Pictures already saved stay in the database but are no longer shown.",
  },
  {
    key: "CLIENT_SMART_IMPORT",
    label: "Clients — Smart Bulk Import",
    description:
      "Import up to 5,000 clients from any Excel or CSV file: map each field to a column, a fixed value or a sample, correct rows before saving, and import in the background (SMART_IMPORT.md). Needs Client Management. Off = the original import.",
    defaultEnabled: false,
    // A new way of writing many client records at once: switched on by a person, never by a plan.
    manualOnly: true,
    routes: [],
    permissionKeys: [],
    workerEffect:
      "Nothing runs in the WhatsApp worker. Off stops new smart imports; one already running finishes in the app's background processor, and the original import is used again.",
  },
  {
    key: "INBOX_COLLABORATION",
    label: "Inbox workspace — notes, priority, tags",
    description:
      "A side panel in WhatsApp Chat and All Conversations: internal notes with @mentions, priority, tags and Team assignment (INBOX_WORKSPACE.md). Notes are never sent to a customer. Off = the conversation views exactly as before; saved notes and tags are kept.",
    // A presentation switch over existing pages (messages.view to read, the reply keys to write).
    defaultEnabled: false,
    routes: [],
    permissionKeys: [],
    workerEffect: "Nothing runs in the background for it.",
  },
  {
    key: "AI_COPILOT",
    label: "AI Copilot for agents",
    description:
      "The Copilot tab in the conversation side panel: a summary with verified knowledge and next steps, a suggested reply, and rewrites of the agent's own text (INBOX_WORKSPACE.md). Nothing is ever sent by it — the agent edits and sends. Needs the AI Engine and a Response model.",
    defaultEnabled: false,
    routes: [],
    permissionKeys: [],
    workerEffect: "Stops answering Copilot requests; requests already waiting stay unanswered until it is on again.",
  },
  {
    key: "PRODUCT_CATALOG",
    label: "Product Catalog",
    description: "Products, categories, variants, SKUs, prices and stock (COMMERCE.md).",
    // Additive and new: no project gets it until it is chosen in the Module Builder.
    defaultEnabled: false,
    routes: ["/commerce/products"],
    permissionKeys: ["commerce.view", "commerce.manage"],
    workerEffect: "Nothing runs in the background for it. Products and stock history are kept; AI stops looking products up.",
  },
  {
    key: "ORDERS",
    label: "Order Management",
    description: "Draft, confirm and track orders: items, totals, payment state, stock, cancellations and returns (COMMERCE.md).",
    defaultEnabled: false,
    routes: ["/commerce/orders"],
    permissionKeys: ["orders.view", "orders.manage"],
    workerEffect: "Nothing runs in the background for it. Orders and their history are kept; no new order can be created or moved.",
  },
  {
    key: "SALES_PIPELINE",
    label: "Leads & Sales Pipeline",
    description: "Leads, stages, follow-ups and conversion to clients and orders (COMMERCE.md).",
    defaultEnabled: false,
    routes: ["/sales"],
    permissionKeys: ["sales.view", "sales.manage"],
    workerEffect: "Nothing runs in the background for it. Leads and their history are kept.",
  },
  {
    key: "COURIER",
    label: "Courier Management",
    description: "Book and track deliveries with Steadfast, Pathao Courier and RedX (COMMERCE_INTEGRATIONS.md).",
    defaultEnabled: false,
    routes: ["/commerce/shipments", "/settings/couriers"],
    permissionKeys: ["shipments.view", "shipments.manage", "couriers.manage"],
    workerEffect: "Delivery statuses stop being refreshed. Shipments and their history are kept; nothing is booked.",
  },
  {
    key: "WOOCOMMERCE",
    label: "WooCommerce",
    description: "Import a WooCommerce shop's products, stock and orders, keep them updated by webhook, and send approved orders to it.",
    defaultEnabled: false,
    routes: ["/settings/woocommerce"],
    permissionKeys: ["woocommerce.manage"],
    workerEffect: "The shop's webhooks are refused and nothing is imported. Imported products and orders are kept.",
  },
  {
    key: "SHOPIFY",
    label: "Shopify",
    description: "Import a Shopify store's products, stock and orders, keep them updated by webhook, and send approved orders to it as drafts.",
    defaultEnabled: false,
    routes: ["/settings/shopify"],
    permissionKeys: ["shopify.manage"],
    workerEffect: "The store's webhooks are refused and nothing is imported. Imported products and orders are kept.",
  },
  {
    key: "API_ACCESS",
    label: "API & Webhooks",
    description: "Scoped API keys for the public API, and signed webhooks to your own systems, n8n or Zapier (INTEGRATION_HUB.md).",
    defaultEnabled: false,
    routes: ["/settings/api"],
    permissionKeys: ["api.manage"],
    workerEffect: "API keys stop working and no webhook is sent. Keys, endpoints and delivery history are kept.",
  },
  {
    key: "SOCIAL_STUDIO",
    label: "Social Studio",
    description:
      "Get Assist's own social media publishing: connect Facebook Pages and Instagram accounts, write, approve, schedule and follow posts, with a calendar, media library, campaigns, templates and AI help (SOCIAL_STUDIO.md). Nothing is published without a person's approval.",
    defaultEnabled: false,
    // It publishes to a business's public channels: switched on by a person, never by a plan.
    manualOnly: true,
    routes: ["/social", "/settings/social"],
    permissionKeys: ["social.view", "social.edit", "social.approve", "social.publish", "social.manage"],
    workerEffect:
      "Nothing is published and nothing is checked: scheduled posts wait, and publish when it is on again only if their time has not passed. Drafts, history, media and connections are kept.",
  },
] as const satisfies readonly ProjectFeatureDefinition[];

export type ProjectFeatureKey = (typeof PROJECT_FEATURES)[number]["key"];

const BY_KEY = new Map<string, ProjectFeatureDefinition>(PROJECT_FEATURES.map((f) => [f.key, f]));

export function isProjectFeatureKey(value: unknown): value is ProjectFeatureKey {
  return typeof value === "string" && BY_KEY.has(value);
}

export function projectFeatureDefinition(key: ProjectFeatureKey): ProjectFeatureDefinition {
  return BY_KEY.get(key)!;
}

/** Every route prefix, longest first, so `/support-activity/team` resolves before `/support-activity`. */
const ROUTES: Array<[string, ProjectFeatureKey]> = PROJECT_FEATURES.flatMap((f) =>
  f.routes.map((route) => [route, f.key] as [string, ProjectFeatureKey]),
).sort((a, b) => b[0].length - a[0].length);

/** The feature a project-relative path belongs to ("/chat/abc?x=1" → WHATSAPP_CHAT), or null. */
export function featureForPath(path: string): ProjectFeatureKey | null {
  const clean = path.split("?")[0]!.split("#")[0]!;
  const hit = ROUTES.find(([prefix]) => clean === prefix || clean.startsWith(`${prefix}/`));
  return hit ? hit[1] : null;
}

const KEYS = new Map<string, ProjectFeatureKey>(
  PROJECT_FEATURES.flatMap((f) => f.permissionKeys.map((key) => [key, f.key] as [string, ProjectFeatureKey])),
);

/** The feature a permission key belongs exclusively to, or null for a key shared across modules. */
export function featureForPermissionKey(key: string): ProjectFeatureKey | null {
  return KEYS.get(key) ?? null;
}

/** The effective state of every feature for one project: its stored row, else the default. */
export function resolveProjectFeatures(
  rows: ReadonlyArray<{ key: string; enabled: boolean }>,
): Array<ProjectFeatureDefinition & { enabled: boolean; isDefault: boolean }> {
  const stored = new Map(rows.map((row) => [row.key, row.enabled]));
  return PROJECT_FEATURES.map((feature) => {
    const value = stored.get(feature.key);
    return { ...feature, enabled: value ?? feature.defaultEnabled, isDefault: value === undefined || value === feature.defaultEnabled };
  });
}

/** The keys switched off, from a project's stored rows — what the web and the worker read. */
export function disabledProjectFeatures(rows: ReadonlyArray<{ key: string; enabled: boolean }>): Set<ProjectFeatureKey> {
  return new Set(resolveProjectFeatures(rows).filter((f) => !f.enabled).map((f) => f.key as ProjectFeatureKey));
}

/** Whether a path may be opened given the disabled set — a path with no feature always may. */
export function pathAllowedByFeatures(path: string, disabled: ReadonlySet<string>): boolean {
  const feature = featureForPath(path);
  return feature === null || !disabled.has(feature);
}
