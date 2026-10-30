import { PROJECT_FEATURES, type ProjectFeatureKey } from "./projectFeatures.js";

/**
 * Project types, modules and the dependency rules between them (PROJECT_MODULES.md).
 *
 * A MODULE is the Main Admin's unit of choice. Every available module is exactly one existing
 * `PROJECT_FEATURES` entitlement — there is no second switch. Its label, description, routes,
 * permission keys and background effect are READ from that entry, never restated here; this file
 * adds only what a feature does not carry: category, benefits, dependencies, which business types
 * recommend it, and setup notes. A module still being built is listed as PLANNED, with no feature
 * behind it, and can never be selected.
 *
 * The layers stay separate (PROJECT_MODULES.md §2):
 *   project type  – a business profile label + the template it started from;
 *   template      – the recommended selection for a type (a proposal, nothing more);
 *   selection     – what the admin chose, stored as the `ProjectFeature` rows that already gate
 *                   nav, pages, actions and the worker;
 *   plan          – the customer's subscription, which may restrict what can be ADDED;
 *   permissions   – unchanged: a role still decides what each person may do inside.
 * Choosing a type never grants a plan feature and never grants a permission.
 */

export const PROJECT_TYPES = ["DEFAULT", "ECOMMERCE", "CUSTOM_MIX"] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];
/** The types that carry a template. CUSTOM_MIX is a selection, optionally started from one of these. */
export type ProjectBaseType = Exclude<ProjectType, "CUSTOM_MIX">;

export const PROJECT_TYPE_LABELS: Record<ProjectType, string> = {
  DEFAULT: "Default",
  ECOMMERCE: "E-commerce",
  CUSTOM_MIX: "Custom Mix",
};

export const PROJECT_TYPE_DESCRIPTIONS: Record<ProjectType, string> = {
  DEFAULT: "The original Get Assist: WhatsApp support, AI answers, team reports and support tracking.",
  ECOMMERCE: "Selling and supporting customers across channels: inbox, clients, AI and (as they ship) catalogue, orders and couriers.",
  CUSTOM_MIX: "Any combination of modules. Dependencies are added for you; nothing is copied from another project.",
};

export function isProjectType(value: unknown): value is ProjectType {
  return typeof value === "string" && (PROJECT_TYPES as readonly string[]).includes(value);
}

export const MODULE_CATEGORIES = ["Messaging", "AI", "Team", "Support", "Customers", "Commerce", "Integrations", "Presentation"] as const;
export type ModuleCategory = (typeof MODULE_CATEGORIES)[number];

/**
 * HARD: cannot work without it — added automatically, and never removed while the dependent stays.
 *   With several keys it is ONE_OF: at least one of them must be selected (the first one the plan
 *   allows is added when none is).
 * RECOMMENDED: works better with it — proposed, and the admin may decline.
 * OPTIONAL: can be connected later; shown for information only.
 */
export interface ModuleDependency {
  kind: "HARD" | "RECOMMENDED" | "OPTIONAL";
  anyOf: readonly string[];
  why: string;
}

export type ModuleStatus = "AVAILABLE" | "PLANNED";

export interface ModuleDefinition {
  key: string;
  name: string;
  category: ModuleCategory;
  description: string;
  benefits: readonly string[];
  status: ModuleStatus;
  /** The entitlement switch this module IS. Null only for a PLANNED module. */
  featureKey: ProjectFeatureKey | null;
  /** Business types whose template selects it. CUSTOM_MIX may select any AVAILABLE module. */
  defaultForTypes: readonly ProjectBaseType[];
  dependencies: readonly ModuleDependency[];
  conflicts: readonly string[];
  permissionKeys: readonly string[];
  routes: readonly string[];
  aiCapabilities: readonly string[];
  hasBackgroundJobs: boolean;
  /** Plain words: what switching it off does. */
  whenOff: string;
  /** Data is always kept when a module is switched off; this says what stays readable. */
  dataWhenOff: string;
  /** Set by a person only, never by a plan (WHATSAPP_AVATARS.md). */
  manualOnly: boolean;
  setupSteps: readonly string[];
  documentation?: string;
}

type ModuleMeta = Omit<ModuleDefinition, "key" | "name" | "description" | "status" | "featureKey" | "permissionKeys" | "routes" | "whenOff" | "manualOnly"> & {
  whenOff?: string;
};

const KEPT = "Its records and settings are kept. Its pages are hidden while it is off and come back unchanged when it is switched on again.";
const NO_DATA = "It stores nothing of its own; switching it off only changes what is shown.";

/** One entry per existing feature. A test fails when a feature has none. */
const FEATURE_MODULE_META: Record<ProjectFeatureKey, ModuleMeta> = {
  WHATSAPP_CHAT: {
    category: "Messaging",
    benefits: ["Answer every WhatsApp group and personal chat from one inbox", "See who replied, from which number"],
    defaultForTypes: ["DEFAULT", "ECOMMERCE"],
    dependencies: [],
    conflicts: [],
    aiCapabilities: [],
    hasBackgroundJobs: false,
    dataWhenOff: "Messages are still collected and shown under Messages. " + KEPT,
    setupSteps: ["Connect a WhatsApp number under WhatsApp → Accounts"],
    documentation: "WHATSAPP_CHAT_MULTI_ACCOUNT_AUDIT.md",
  },
  AI_REPLY: {
    category: "AI",
    benefits: ["Customers get an answer when no rule matches", "Hands over to a person when it is not sure"],
    defaultForTypes: ["DEFAULT", "ECOMMERCE"],
    dependencies: [{ kind: "RECOMMENDED", anyOf: ["AI_LEARNING"], why: "AI answers only from verified knowledge, which AI Learning manages." }],
    conflicts: [],
    aiCapabilities: ["Answer customer questions from verified knowledge", "Hand over to a person"],
    hasBackgroundJobs: true,
    dataWhenOff: "The AI decision log is kept. " + KEPT,
    setupSteps: ["Add an AI provider and a Response model", "Switch on the AI Engine in AI Settings", "Choose which groups AI may answer"],
  },
  AI_LEARNING: {
    category: "AI",
    benefits: ["A reviewed knowledge base the AI answers from", "Import manuals, files and spreadsheets"],
    defaultForTypes: ["DEFAULT", "ECOMMERCE"],
    dependencies: [],
    conflicts: [],
    aiCapabilities: ["Build knowledge from imports and group chats", "Learn the team's writing style"],
    hasBackgroundJobs: true,
    dataWhenOff: "Knowledge entries are kept. " + KEPT,
    setupSteps: ["Import or write knowledge entries", "Verify them in Pending review"],
  },
  CONVERSATION_LEARNING: {
    category: "AI",
    benefits: ["Finds questions customers ask again and again", "Proposes rules for a person to approve"],
    defaultForTypes: ["DEFAULT"],
    dependencies: [{ kind: "RECOMMENDED", anyOf: ["AI_LEARNING"], why: "Its findings become knowledge entries." }],
    conflicts: [],
    aiCapabilities: ["Detect recurring patterns", "Draft rule proposals", "AI sandbox"],
    hasBackgroundJobs: true,
    dataWhenOff: "Patterns and proposals are kept. " + KEPT,
    setupSteps: ["Switch on Conversation Learning in its settings"],
  },
  TEAM_MANAGEMENT: {
    category: "Team",
    benefits: ["Shifts, roster and leave", "Duty history from real messages"],
    defaultForTypes: ["DEFAULT"],
    dependencies: [],
    conflicts: [],
    aiCapabilities: [],
    hasBackgroundJobs: true,
    dataWhenOff: "Rosters, leave and attendance history are kept. " + KEPT,
    setupSteps: ["Add team members", "Create shifts and a weekly roster"],
  },
  TEAM_REPORTS: {
    category: "Team",
    benefits: ["Per-person and per-group support figures", "Missed replies, recalls and overtime"],
    defaultForTypes: ["DEFAULT", "ECOMMERCE"],
    dependencies: [{ kind: "RECOMMENDED", anyOf: ["TEAM_MANAGEMENT"], why: "Overtime uses each member's roster; without it the 8-hour fallback is used." }],
    conflicts: [],
    aiCapabilities: [],
    hasBackgroundJobs: false,
    dataWhenOff: "The reports read stored messages, so nothing is lost. " + KEPT,
    setupSteps: ["Add team members so their replies are recognised"],
  },
  BULK_MESSAGING: {
    category: "Messaging",
    benefits: ["Broadcast to many groups safely", "Add a number to groups or make it admin"],
    defaultForTypes: ["DEFAULT"],
    dependencies: [],
    conflicts: [],
    aiCapabilities: [],
    hasBackgroundJobs: true,
    dataWhenOff: "Job history is kept; no new job can start. " + KEPT,
    setupSteps: ["Review the Sending Limits before the first broadcast"],
  },
  ESCALATIONS: {
    category: "Support",
    benefits: ["SLA timers on priority groups", "Alerts that climb to a member and an admin"],
    defaultForTypes: ["DEFAULT"],
    dependencies: [],
    conflicts: [],
    aiCapabilities: [],
    hasBackgroundJobs: true,
    dataWhenOff: "Cases are kept; open cases stop advancing. " + KEPT,
    setupSteps: ["Create escalation policies", "Give groups a priority"],
  },
  SUPPORT_ASSIGNMENT: {
    category: "Support",
    benefits: ["Assign each waiting customer to a person", "Overdue alerts and a report"],
    defaultForTypes: ["DEFAULT", "ECOMMERCE"],
    dependencies: [],
    conflicts: [],
    aiCapabilities: [],
    hasBackgroundJobs: true,
    dataWhenOff: "Cases are kept; none are opened or completed. " + KEPT,
    setupSteps: ["Choose the Support Team on Support Activity Setup"],
  },
  SUPPORT_ACTIVITY: {
    category: "Support",
    benefits: ["Records the support each member gives", "Activity feed and report"],
    defaultForTypes: ["DEFAULT"],
    dependencies: [],
    conflicts: [],
    aiCapabilities: [],
    hasBackgroundJobs: true,
    dataWhenOff: "Recorded activity is kept. " + KEPT,
    setupSteps: ["Switch on tracking and add rules on Support Activity Setup"],
  },
  PRODUCT_KNOWLEDGE_FORGE: {
    category: "AI",
    benefits: ["Answers about the product from its own repository"],
    defaultForTypes: ["DEFAULT"],
    dependencies: [{ kind: "RECOMMENDED", anyOf: ["AI_LEARNING"], why: "What it learns is stored as knowledge entries." }],
    conflicts: [],
    aiCapabilities: ["Research a question in the product's source"],
    hasBackgroundJobs: true,
    dataWhenOff: "Knowledge it produced is kept. " + KEPT,
    setupSteps: ["Set FORGE_API_KEY and FORGE_API_URL on the server", "Enable it under Product Knowledge"],
  },
  GOOGLE_SHEETS: {
    category: "Integrations",
    benefits: ["Work on Google Sheets from the app", "Track who worked on which sheet"],
    defaultForTypes: [],
    dependencies: [],
    conflicts: [],
    aiCapabilities: [],
    hasBackgroundJobs: true,
    dataWhenOff: "Connected accounts, sheets and history are kept. " + KEPT,
    setupSteps: ["Configure the Google OAuth client", "Connect a Google account"],
    documentation: "GOOGLE_SHEETS.md",
  },
  OMNICHANNEL: {
    category: "Messaging",
    benefits: ["Messenger, Instagram, Telegram and Website Chat beside WhatsApp", "One list of every conversation"],
    defaultForTypes: ["ECOMMERCE"],
    dependencies: [],
    conflicts: [],
    aiCapabilities: ["AI replies on Messenger, Instagram, Telegram and Website Chat"],
    hasBackgroundJobs: true,
    dataWhenOff: "Webhooks are still recorded so nothing is lost; connections and history are kept. " + KEPT,
    setupSteps: ["Connect a channel under Settings → Messaging Channels"],
    documentation: "OMNICHANNEL.md",
  },
  CLIENT_CENTER: {
    category: "Customers",
    benefits: ["One client database across channels", "Subscriptions, invoices and payments"],
    defaultForTypes: ["ECOMMERCE"],
    dependencies: [],
    conflicts: [],
    aiCapabilities: [],
    hasBackgroundJobs: false,
    dataWhenOff: "Client records, billing and history are kept. " + KEPT,
    setupSteps: ["Import or add clients", "Add a billing currency before recording money"],
    documentation: "CLIENT_CENTER.md",
  },
  CHAT_UI_V2: {
    category: "Presentation",
    benefits: ["Older history, quoted replies, reactions, files and mentions in WhatsApp Chat"],
    defaultForTypes: [],
    dependencies: [{ kind: "HARD", anyOf: ["WHATSAPP_CHAT"], why: "It is a new view of WhatsApp Chat." }],
    conflicts: [],
    aiCapabilities: [],
    hasBackgroundJobs: false,
    dataWhenOff: NO_DATA,
    setupSteps: [],
    documentation: "CHAT_UI_V2.md",
  },
  UNIFIED_REPORTING: {
    category: "Presentation",
    benefits: ["Personal-chat and combined scopes in the Team Report", "Rankings and comparisons"],
    defaultForTypes: [],
    dependencies: [{ kind: "HARD", anyOf: ["TEAM_REPORTS"], why: "It adds to the Team Report." }],
    conflicts: [],
    aiCapabilities: [],
    hasBackgroundJobs: false,
    dataWhenOff: NO_DATA,
    setupSteps: [],
  },
  WHATSAPP_AVATARS: {
    category: "Presentation",
    benefits: ["Profile pictures and group icons in WhatsApp Chat"],
    defaultForTypes: [],
    dependencies: [{ kind: "HARD", anyOf: ["WHATSAPP_CHAT"], why: "The pictures are shown in WhatsApp Chat." }],
    conflicts: [],
    aiCapabilities: [],
    hasBackgroundJobs: true,
    dataWhenOff: "Saved pictures stay in the database but are not shown.",
    setupSteps: [],
    documentation: "WHATSAPP_AVATARS.md",
  },
  CLIENT_SMART_IMPORT: {
    category: "Customers",
    benefits: ["Import up to 5,000 clients from any spreadsheet", "Fix rows before saving"],
    defaultForTypes: [],
    dependencies: [{ kind: "HARD", anyOf: ["CLIENT_CENTER"], why: "It imports into Client Management." }],
    conflicts: [],
    aiCapabilities: [],
    hasBackgroundJobs: true,
    dataWhenOff: "Imported clients are kept; the original import is used again.",
    setupSteps: [],
    documentation: "SMART_IMPORT.md",
  },
  INBOX_COLLABORATION: {
    category: "Support",
    benefits: ["Internal notes with @mentions", "Priority, tags and Team assignment on conversations"],
    defaultForTypes: ["ECOMMERCE"],
    dependencies: [{ kind: "HARD", anyOf: ["WHATSAPP_CHAT", "OMNICHANNEL"], why: "The panel opens beside a conversation in WhatsApp Chat or All Conversations." }],
    conflicts: [],
    aiCapabilities: [],
    hasBackgroundJobs: false,
    dataWhenOff: "Notes and tags are kept. " + KEPT,
    setupSteps: [],
    documentation: "INBOX_WORKSPACE.md",
  },
  PRODUCT_CATALOG: {
    category: "Commerce",
    benefits: ["One catalogue of products, variants and prices", "Stock that moves with every order, with its history"],
    defaultForTypes: ["ECOMMERCE"],
    dependencies: [],
    conflicts: [],
    aiCapabilities: ["Look up products, prices and stock"],
    hasBackgroundJobs: false,
    dataWhenOff: "Products and stock history are kept. " + KEPT,
    setupSteps: ["Add categories and products, or import them"],
    documentation: "COMMERCE.md",
  },
  ORDERS: {
    category: "Commerce",
    benefits: ["Orders from any channel in one list", "Totals, payments, stock and returns handled exactly"],
    defaultForTypes: ["ECOMMERCE"],
    dependencies: [
      { kind: "HARD", anyOf: ["PRODUCT_CATALOG"], why: "An order line is a catalogue product." },
      { kind: "RECOMMENDED", anyOf: ["CLIENT_CENTER"], why: "An order can then belong to a client, with its whole history." },
    ],
    conflicts: [],
    aiCapabilities: ["Answer order-status questions for a verified customer"],
    hasBackgroundJobs: false,
    dataWhenOff: "Orders and their history are kept. " + KEPT,
    setupSteps: ["Add products to the catalogue"],
    documentation: "COMMERCE.md",
  },
  SALES_PIPELINE: {
    category: "Commerce",
    benefits: ["Every enquiry as a lead with a stage and a follow-up date", "Won leads become clients and orders"],
    defaultForTypes: ["ECOMMERCE"],
    dependencies: [{ kind: "RECOMMENDED", anyOf: ["CLIENT_CENTER"], why: "A won lead becomes a client." }],
    conflicts: [],
    aiCapabilities: [],
    hasBackgroundJobs: false,
    dataWhenOff: "Leads and their history are kept. " + KEPT,
    setupSteps: [],
    documentation: "COMMERCE.md",
  },
  COURIER: {
    category: "Commerce",
    benefits: ["Book a delivery from the order in one step", "Delivery status refreshed by itself"],
    defaultForTypes: ["ECOMMERCE"],
    dependencies: [{ kind: "HARD", anyOf: ["ORDERS"], why: "A shipment is for an order." }],
    conflicts: [],
    aiCapabilities: ["Tell a verified customer where their delivery is"],
    hasBackgroundJobs: true,
    dataWhenOff: "Shipments and their history are kept. " + KEPT,
    setupSteps: ["Connect a courier under Settings → Couriers"],
    documentation: "COMMERCE_INTEGRATIONS.md",
  },
  WOOCOMMERCE: {
    category: "Integrations",
    benefits: ["Products, prices and stock imported from the shop", "Shop orders in the same order list"],
    defaultForTypes: [],
    dependencies: [
      { kind: "HARD", anyOf: ["PRODUCT_CATALOG"], why: "Products are imported into the catalogue." },
      { kind: "RECOMMENDED", anyOf: ["ORDERS"], why: "The shop's orders can then be imported too." },
    ],
    conflicts: [],
    aiCapabilities: [],
    hasBackgroundJobs: false,
    dataWhenOff: "Imported products and orders are kept. " + KEPT,
    setupSteps: ["Create a REST API key in WooCommerce", "Connect it under Settings → WooCommerce"],
    documentation: "COMMERCE_INTEGRATIONS.md",
  },
  SHOPIFY: {
    category: "Integrations",
    benefits: ["Products, prices and stock imported from the store", "Store orders in the same order list"],
    defaultForTypes: [],
    dependencies: [
      { kind: "HARD", anyOf: ["PRODUCT_CATALOG"], why: "Products are imported into the catalogue." },
      { kind: "RECOMMENDED", anyOf: ["ORDERS"], why: "The store's orders can then be imported too." },
    ],
    conflicts: [],
    aiCapabilities: [],
    hasBackgroundJobs: false,
    dataWhenOff: "Imported products and orders are kept. " + KEPT,
    setupSteps: ["Create a custom app in the Shopify admin", "Connect it under Settings → Shopify"],
    documentation: "COMMERCE_INTEGRATIONS.md",
  },
  API_ACCESS: {
    category: "Integrations",
    benefits: ["Read products and orders, create leads from other systems", "Signed webhooks with retries and a delivery history"],
    defaultForTypes: [],
    dependencies: [],
    conflicts: [],
    aiCapabilities: [],
    hasBackgroundJobs: true,
    dataWhenOff: "Keys, endpoints and delivery history are kept. " + KEPT,
    setupSteps: ["Create an API key or a webhook under Settings → API & Webhooks"],
    documentation: "INTEGRATION_HUB.md",
  },
  SOCIAL_STUDIO: {
    category: "Integrations",
    benefits: ["Write, approve and schedule posts for Facebook Pages and Instagram in one place", "A calendar, media library, campaigns and templates"],
    defaultForTypes: [],
    dependencies: [],
    conflicts: [],
    aiCapabilities: [],
    hasBackgroundJobs: true,
    dataWhenOff: "Drafts, scheduled posts, history and the connection are kept. " + KEPT,
    setupSteps: ["Connect Facebook / Instagram under Social Studio → Accounts", "Write a post and have it approved"],
    documentation: "SOCIAL_STUDIO.md",
  },
  AI_COPILOT: {
    category: "AI",
    benefits: ["Conversation summaries and suggested replies for agents", "Nothing is sent without the agent"],
    defaultForTypes: ["ECOMMERCE"],
    dependencies: [
      { kind: "HARD", anyOf: ["WHATSAPP_CHAT", "OMNICHANNEL"], why: "It works beside a conversation in WhatsApp Chat or All Conversations." },
      { kind: "RECOMMENDED", anyOf: ["AI_LEARNING"], why: "Summaries and drafts use verified knowledge." },
    ],
    conflicts: [],
    aiCapabilities: ["Summarise a conversation", "Draft a reply", "Rewrite the agent's text"],
    hasBackgroundJobs: true,
    dataWhenOff: "Drafts already made are kept. " + KEPT,
    setupSteps: ["Add an AI provider and a Response model", "Switch on the AI Engine"],
    documentation: "INBOX_WORKSPACE.md",
  },
};

/**
 * Modules being built. Listed so the builder can say what is coming, never selectable, never a
 * feature. Each becomes AVAILABLE only together with its feature entry and its real implementation.
 */
const PLANNED_MODULES: readonly ModuleDefinition[] = [
  planned("SOCIAL_MANAGEMENT", "Social Management", "Integrations", "Facebook and Instagram comments, replies and comment-to-lead. (Post scheduling is Social Studio.)", [
    { kind: "HARD", anyOf: ["OMNICHANNEL"], why: "It uses the project's Meta connections." },
  ], []),
  planned("AUTOMATION_STUDIO", "Automation Studio", "Integrations", "Visual workflows: triggers, conditions, branches, delays and retries across modules.", [], []),
];

function planned(key: string, name: string, category: ModuleCategory, description: string, dependencies: ModuleDependency[], aiCapabilities: string[]): ModuleDefinition {
  return {
    key,
    name,
    category,
    description,
    benefits: [],
    status: "PLANNED",
    featureKey: null,
    defaultForTypes: [],
    dependencies,
    conflicts: [],
    permissionKeys: [],
    routes: [],
    aiCapabilities,
    hasBackgroundJobs: false,
    whenOff: "Not built yet.",
    dataWhenOff: "Not built yet.",
    manualOnly: false,
    setupSteps: [],
  };
}


export const PROJECT_MODULES: readonly ModuleDefinition[] = [
  ...PROJECT_FEATURES.map((feature): ModuleDefinition => {
    const meta = FEATURE_MODULE_META[feature.key];
    return {
      ...meta,
      key: feature.key,
      name: feature.label,
      description: feature.description,
      status: "AVAILABLE",
      featureKey: feature.key,
      permissionKeys: feature.permissionKeys,
      routes: feature.routes,
      whenOff: meta.whenOff ?? feature.workerEffect,
      manualOnly: "manualOnly" in feature ? Boolean(feature.manualOnly) : false,
    };
  }),
  ...PLANNED_MODULES,
];

const MODULE_BY_KEY = new Map(PROJECT_MODULES.map((m) => [m.key, m]));

export function moduleDefinition(key: string): ModuleDefinition | undefined {
  return MODULE_BY_KEY.get(key);
}

/** The AVAILABLE modules a base type's template selects. */
export function templateModules(type: ProjectBaseType): string[] {
  return PROJECT_MODULES.filter((m) => m.status === "AVAILABLE" && m.defaultForTypes.includes(type)).map((m) => m.key).sort();
}

/** The PLANNED modules a base type will add once they ship (shown, never selected). */
export function plannedModulesFor(type: ProjectBaseType): string[] {
  return PLANNED_MODULES.filter((m) => m.defaultForTypes.includes(type)).map((m) => m.key);
}

/**
 * Built-in module templates (PROJECT_MODULES.md §8): global, read-only, in code. Each names a base type
 * so a selection made from it is recorded as that type or as "Custom Mix (<base> base)". Customers'
 * own templates are rows (`ModuleTemplate`), private to the customer. A test keeps every built-in
 * self-consistent: it resolves with nothing added and nothing unavailable.
 */
export interface BuiltInModuleTemplate {
  key: string;
  name: string;
  description: string;
  baseType: ProjectBaseType;
  modules: readonly string[];
}

const BUILT_IN_TEMPLATE_SOURCES: readonly BuiltInModuleTemplate[] = [
  { key: "builtin:DEFAULT", name: "Default", description: PROJECT_TYPE_DESCRIPTIONS.DEFAULT, baseType: "DEFAULT", modules: [] },
  { key: "builtin:ECOMMERCE", name: "E-commerce", description: PROJECT_TYPE_DESCRIPTIONS.ECOMMERCE, baseType: "ECOMMERCE", modules: [] },
  {
    key: "builtin:MESSAGING_ESSENTIALS",
    name: "Messaging Essentials",
    description: "WhatsApp and the other channels in one inbox, with notes and tags. No AI, no reports.",
    baseType: "DEFAULT",
    modules: ["INBOX_COLLABORATION", "OMNICHANNEL", "WHATSAPP_CHAT"],
  },
  {
    key: "builtin:CUSTOMER_SUPPORT",
    name: "Customer Support",
    description: "WhatsApp support with AI answers, assignment, escalations and team reports.",
    baseType: "DEFAULT",
    modules: ["AI_LEARNING", "AI_REPLY", "ESCALATIONS", "INBOX_COLLABORATION", "SUPPORT_ACTIVITY", "SUPPORT_ASSIGNMENT", "TEAM_REPORTS", "WHATSAPP_CHAT"],
  },
  {
    key: "builtin:AI_FIRST_SUPPORT",
    name: "AI-First Support",
    description: "Every channel answered by AI from verified knowledge, with the Copilot for agents.",
    baseType: "DEFAULT",
    modules: ["AI_COPILOT", "AI_LEARNING", "AI_REPLY", "CONVERSATION_LEARNING", "INBOX_COLLABORATION", "OMNICHANNEL", "WHATSAPP_CHAT"],
  },
  {
    key: "builtin:SALES_CRM",
    name: "Sales & CRM",
    description: "Every channel with a client database, the sales pipeline, notes, tags and the AI Copilot.",
    baseType: "ECOMMERCE",
    modules: ["AI_COPILOT", "AI_LEARNING", "CLIENT_CENTER", "INBOX_COLLABORATION", "OMNICHANNEL", "SALES_PIPELINE", "WHATSAPP_CHAT"],
  },
];

/** An empty `modules` list means "the base type's own template", filled in here. */
export const BUILT_IN_MODULE_TEMPLATES: readonly BuiltInModuleTemplate[] = BUILT_IN_TEMPLATE_SOURCES.map((t) =>
  t.modules.length === 0 ? { ...t, modules: templateModules(t.baseType) } : t,
);

export function builtInModuleTemplate(key: string): BuiltInModuleTemplate | undefined {
  return BUILT_IN_MODULE_TEMPLATES.find((t) => t.key === key);
}

/**
 * The type to record for a selection: a base type when the selection is exactly its template,
 * otherwise CUSTOM_MIX with the base it started from ("Custom Mix (E-commerce base)").
 */
export function typeForSelection(selected: readonly string[], base: ProjectBaseType | null): { projectType: ProjectType; baseType: ProjectBaseType | null } {
  const set = [...new Set(selected)].sort().join(",");
  for (const type of ["DEFAULT", "ECOMMERCE"] as const) {
    if (templateModules(type).join(",") === set && (base === null || base === type)) return { projectType: type, baseType: type };
  }
  return { projectType: "CUSTOM_MIX", baseType: base };
}

/**
 * What the customer's subscription allows to be ADDED. `restricted: false` = no subscription, or an
 * "All Access" plan: nothing is held back (a customer with no plan is never limited — SAAS_PLATFORM_PLAN
 * §10). A manualOnly module is never decided by a plan, so a plan never holds it back.
 */
export interface ModuleEntitlement {
  restricted: boolean;
  allowedFeatures: readonly string[];
}

export function moduleEntitled(entitlement: ModuleEntitlement, key: string): boolean {
  const def = MODULE_BY_KEY.get(key);
  if (!def) return false;
  if (!entitlement.restricted || def.manualOnly) return true;
  return entitlement.allowedFeatures.includes(key);
}

export type ModuleIssueCode = "UNKNOWN_MODULE" | "NOT_AVAILABLE" | "NOT_IN_PLAN" | "CONFLICT" | "DEPENDENCY_NOT_IN_PLAN";

export interface ModuleIssue {
  code: ModuleIssueCode;
  key: string;
  message: string;
}

export interface ModuleResolution {
  ok: boolean;
  /** The final selection, sorted: the request plus every hard dependency. */
  selected: string[];
  /** Modules added because something selected needs them. */
  autoAdded: Array<{ key: string; requiredBy: string; why: string }>;
  /** Recommended modules not selected and not declined: offered to the admin. */
  recommended: Array<{ key: string; recommendedBy: string; why: string }>;
  /** Recommended modules the admin explicitly declined (kept so the builder stops offering them). */
  declined: string[];
  /** Modules already ON that the plan would not allow adding today: kept, reported, never forced off. */
  grandfathered: string[];
  issues: ModuleIssue[];
}

/**
 * Resolve a requested selection (PROJECT_MODULES.md §4). Deterministic: the same input always gives
 * the same output, in sorted order. The server calls this on what the browser sends and saves only
 * `selected` when `ok` — a removed hard dependency simply comes back, so no invalid state can be
 * stored. `currentlyEnabled` lets a module already on stay on even if the plan would not allow
 * adding it now; only NEW additions are checked against the plan.
 */
export function resolveModuleSelection(input: {
  requested: readonly string[];
  declined?: readonly string[];
  entitlement: ModuleEntitlement;
  currentlyEnabled?: readonly string[];
}): ModuleResolution {
  const issues: ModuleIssue[] = [];
  const current = new Set(input.currentlyEnabled ?? []);
  const allowed = (key: string) => current.has(key) || moduleEntitled(input.entitlement, key);
  const selected = new Set<string>();
  for (const key of [...new Set(input.requested)].sort()) {
    const def = MODULE_BY_KEY.get(key);
    if (!def) issues.push({ code: "UNKNOWN_MODULE", key, message: `Unknown module "${key}".` });
    else if (def.status !== "AVAILABLE") issues.push({ code: "NOT_AVAILABLE", key, message: `${def.name} is not available yet.` });
    else if (!allowed(key)) issues.push({ code: "NOT_IN_PLAN", key, message: `${def.name} is not included in this customer's plan.` });
    else selected.add(key);
  }

  // Hard dependencies, to a fixed point. Sorted iteration keeps the result deterministic.
  const autoAdded: ModuleResolution["autoAdded"] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const key of [...selected].sort()) {
      for (const dep of MODULE_BY_KEY.get(key)!.dependencies) {
        if (dep.kind !== "HARD" || dep.anyOf.some((k) => selected.has(k))) continue;
        const pick = dep.anyOf.find((k) => MODULE_BY_KEY.get(k)?.status === "AVAILABLE" && allowed(k));
        if (!pick) {
          const names = dep.anyOf.map((k) => MODULE_BY_KEY.get(k)?.name ?? k).join(" or ");
          issues.push({ code: "DEPENDENCY_NOT_IN_PLAN", key, message: `${MODULE_BY_KEY.get(key)!.name} needs ${names}, which this customer's plan does not include.` });
          continue;
        }
        selected.add(pick);
        autoAdded.push({ key: pick, requiredBy: key, why: dep.why });
        changed = true;
      }
    }
  }

  for (const key of [...selected].sort()) {
    for (const other of MODULE_BY_KEY.get(key)!.conflicts) {
      if (selected.has(other) && key < other) {
        issues.push({ code: "CONFLICT", key, message: `${MODULE_BY_KEY.get(key)!.name} cannot be used together with ${MODULE_BY_KEY.get(other)?.name ?? other}.` });
      }
    }
  }

  const declinedSet = new Set(input.declined ?? []);
  const recommended: ModuleResolution["recommended"] = [];
  const seen = new Set<string>();
  for (const key of [...selected].sort()) {
    for (const dep of MODULE_BY_KEY.get(key)!.dependencies) {
      if (dep.kind !== "RECOMMENDED" || dep.anyOf.some((k) => selected.has(k))) continue;
      const pick = dep.anyOf.find((k) => MODULE_BY_KEY.get(k)?.status === "AVAILABLE" && allowed(k));
      if (!pick || declinedSet.has(pick) || seen.has(pick)) continue;
      seen.add(pick);
      recommended.push({ key: pick, recommendedBy: key, why: dep.why });
    }
  }

  const sorted = [...selected].sort();
  const unique = [...new Map(issues.map((i) => [`${i.code}|${i.key}|${i.message}`, i])).values()];
  return {
    ok: unique.length === 0,
    selected: sorted,
    autoAdded,
    recommended,
    declined: [...declinedSet].filter((k) => !selected.has(k)).sort(),
    grandfathered: sorted.filter((k) => current.has(k) && !moduleEntitled(input.entitlement, k)),
    issues: unique,
  };
}

/**
 * What else must go if `key` is removed from `selection`: every module whose hard dependency would no
 * longer be met, transitively. The builder shows this before removing anything.
 */
export function removalImpact(selection: readonly string[], key: string): string[] {
  const remaining = new Set(selection);
  remaining.delete(key);
  const removed: string[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const k of [...remaining].sort()) {
      const def = MODULE_BY_KEY.get(k);
      if (!def) continue;
      const broken = def.dependencies.some((d) => d.kind === "HARD" && !d.anyOf.some((a) => remaining.has(a)));
      if (broken) {
        remaining.delete(k);
        removed.push(k);
        changed = true;
      }
    }
  }
  return removed;
}

/** Modules whose hard dependencies form a cycle (must be empty — a test pins it). */
export function moduleDependencyCycles(modules: readonly ModuleDefinition[] = PROJECT_MODULES): string[][] {
  const byKey = new Map(modules.map((m) => [m.key, m]));
  const cycles: string[][] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (key: string, path: string[]) => {
    if (state.get(key) === "done") return;
    if (state.get(key) === "visiting") {
      cycles.push([...path.slice(path.indexOf(key)), key]);
      return;
    }
    state.set(key, "visiting");
    for (const dep of byKey.get(key)?.dependencies ?? []) {
      if (dep.kind !== "HARD") continue;
      for (const next of dep.anyOf) if (byKey.has(next)) visit(next, [...path, key]);
    }
    state.set(key, "done");
  };
  for (const m of modules) visit(m.key, []);
  return cycles;
}

/** The difference between two selections, for the review step and the change history. */
export function moduleSelectionDiff(before: readonly string[], after: readonly string[]): { added: string[]; removed: string[] } {
  const a = new Set(before);
  const b = new Set(after);
  return { added: [...b].filter((k) => !a.has(k)).sort(), removed: [...a].filter((k) => !b.has(k)).sort() };
}

/**
 * The AI capabilities the selection actually enables — the basis for the type-aware AI policy
 * (PROJECT_MODULES.md §9): built from what is ON, never from the type label, so a project without
 * a module is never told it can do what that module does.
 */
export function enabledAiCapabilities(selected: readonly string[]): string[] {
  return [...new Set(selected.flatMap((k) => MODULE_BY_KEY.get(k)?.aiCapabilities ?? []))].sort();
}
