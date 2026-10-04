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
      "/reports/executive-health", "/reports/support-intelligence", "/reports/employee-effectiveness", "/reports/support-cases", "/reports/human-response-sla", "/reports/customer-signals",
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
    description: "Learning from the product's own repository through Softify Forge.",
    defaultEnabled: true,
    routes: ["/integrations/forge"],
    permissionKeys: [],
    workerEffect: "The Forge sync, question research and live answer research stop.",
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
