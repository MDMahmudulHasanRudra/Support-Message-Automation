/**
 * The project feature catalogue (MULTI_PROJECT_PLAN.md §9).
 *
 * Phase 4 introduces the catalogue so a new project is created with its default feature rows and
 * the Main Admin Portal can show what each project has. Nothing reads these rows to turn a module
 * off yet — that enforcement, and the controls to change a feature, are Phase 5. Until then every
 * project has every feature, which is exactly what the defaults below say.
 *
 * An absent `ProjectFeature` row means the catalogue default, the same shape as
 * `NotificationEventSetting`, so adding a feature later needs no migration or backfill.
 */

export interface ProjectFeatureDefinition {
  key: string;
  label: string;
  description: string;
  defaultEnabled: boolean;
}

export const PROJECT_FEATURES = [
  { key: "WHATSAPP_CHAT", label: "WhatsApp Chat", description: "The shared inbox and manual replies.", defaultEnabled: true },
  { key: "AI_REPLY", label: "AI replies", description: "AI answers customers when no rule matches.", defaultEnabled: true },
  { key: "AI_LEARNING", label: "AI Learning", description: "Knowledge base, imports and the AI sandbox.", defaultEnabled: true },
  {
    key: "CONVERSATION_LEARNING",
    label: "Conversation Learning",
    description: "Recurring-pattern detection and rule proposals.",
    defaultEnabled: true,
  },
  { key: "TEAM_MANAGEMENT", label: "Team Management", description: "Shifts, roster, leave and coverage.", defaultEnabled: true },
  { key: "TEAM_REPORTS", label: "Team reports", description: "Team Report and Team Performance.", defaultEnabled: true },
  { key: "BULK_MESSAGING", label: "Bulk messaging", description: "Broadcast and Add Number to Groups.", defaultEnabled: true },
  { key: "ESCALATIONS", label: "Escalations", description: "Priority support SLA timers and alerts.", defaultEnabled: true },
  { key: "SUPPORT_ACTIVITY", label: "Support Activity", description: "Support activity tracking and its feed.", defaultEnabled: true },
  {
    key: "PRODUCT_KNOWLEDGE_FORGE",
    label: "Product knowledge (Forge)",
    description: "Learning from the product's own repository through Softify Forge.",
    defaultEnabled: true,
  },
] as const satisfies readonly ProjectFeatureDefinition[];

export type ProjectFeatureKey = (typeof PROJECT_FEATURES)[number]["key"];

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
