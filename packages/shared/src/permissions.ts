/**
 * Canonical permission catalogue for App User Management + Permission Modules. Unlike the
 * string-literal enums in ./enums.ts, permission keys are NOT mirrored as a Prisma `enum` —
 * packages/db/prisma/schema.prisma's `Permission` model is a real, admin-manageable table seeded
 * from this exact list (see packages/db/prisma/seed.ts), so a new permission never needs a
 * migration and a mistyped key fails closed against a real foreign key rather than an unchecked
 * string. This file is the single source of truth for both the seed data and every
 * `requirePermission()` call site in apps/web.
 *
 * Every key here maps to a real, already-shipped module in this application (derived from
 * apps/web/src/app/(dashboard)/Sidebar.tsx's nav groups) — nothing here is a permission for a
 * feature that doesn't exist. `automation_rules`, `users`, `permissions`, `ai_settings`, and
 * `settings` use the finer-grained key lists explicitly requested for those modules; every other
 * real module gets a plain `.view`/`.manage` pair, or a single `.view`-only key for modules with
 * no meaningful separate "manage" action of their own (Messages, Notifications, System Logs).
 */

export interface PermissionDefinition {
  key: string;
  label: string;
  category: string;
}

export const PERMISSIONS: readonly PermissionDefinition[] = [
  // Automation Rules — the one module with the full spec-example CRUD/bulk split.
  { key: "automation_rules.view", label: "View Automation Rules", category: "Automation Rules" },
  { key: "automation_rules.create", label: "Create Automation Rules", category: "Automation Rules" },
  { key: "automation_rules.edit", label: "Edit Automation Rules", category: "Automation Rules" },
  { key: "automation_rules.delete", label: "Delete Automation Rules", category: "Automation Rules" },
  { key: "automation_rules.activate", label: "Activate/Disable Automation Rules", category: "Automation Rules" },
  { key: "automation_rules.bulk_import", label: "Bulk Import Automation Rules", category: "Automation Rules" },
  { key: "automation_rules.bulk_export", label: "Bulk Export Automation Rules", category: "Automation Rules" },

  { key: "messages.view", label: "View Messages", category: "Messages" },

  { key: "escalations.view", label: "View Escalations", category: "Escalations" },
  { key: "escalations.manage", label: "Manage Escalations", category: "Escalations" },

  { key: "support_activity.view", label: "View Support Activity", category: "Support Activity" },
  { key: "support_activity.manage", label: "Manage Support Activity", category: "Support Activity" },

  { key: "teams_integration.view", label: "View Teams Integration", category: "Teams Integration" },
  { key: "teams_integration.manage", label: "Manage Teams Integration", category: "Teams Integration" },

  // Covers WhatsApp Accounts, Groups, and Internal Team Members as one category.
  { key: "whatsapp.view", label: "View WhatsApp Accounts, Groups & Team Members", category: "WhatsApp" },
  { key: "whatsapp.manage", label: "Manage WhatsApp Accounts, Groups & Team Members", category: "WhatsApp" },

  { key: "bulk_messaging.view", label: "View Bulk Messaging", category: "Bulk Messaging" },
  { key: "bulk_messaging.manage", label: "Manage Bulk Messaging", category: "Bulk Messaging" },

  { key: "ai_learning.view", label: "View AI Learning", category: "AI Learning" },
  { key: "ai_learning.manage", label: "Manage AI Learning", category: "AI Learning" },
  { key: "ai_settings.view", label: "View AI Settings", category: "AI Learning" },
  { key: "ai_settings.edit", label: "Edit AI Settings", category: "AI Learning" },

  { key: "conversation_learning.view", label: "View Conversation Learning", category: "Conversation Learning" },
  { key: "conversation_learning.manage", label: "Manage Conversation Learning", category: "Conversation Learning" },

  { key: "notifications.view", label: "View Notifications", category: "System" },
  { key: "settings.view", label: "View Settings", category: "System" },
  { key: "settings.edit", label: "Edit Settings", category: "System" },
  { key: "system_logs.view", label: "View System Logs", category: "System" },

  // Users & Permissions — the module this pass actually enforces, so it gets the finest grain.
  { key: "users.view", label: "View App Users", category: "Users & Permissions" },
  { key: "users.create", label: "Create App Users", category: "Users & Permissions" },
  { key: "users.edit", label: "Edit App Users", category: "Users & Permissions" },
  { key: "users.disable", label: "Activate/Deactivate App Users", category: "Users & Permissions" },
  { key: "users.sessions", label: "View App User Sessions", category: "Users & Permissions" },
  { key: "users.force_logout", label: "Force-Logout App User Sessions", category: "Users & Permissions" },
  { key: "permissions.view", label: "View Permission Modules", category: "Users & Permissions" },
  { key: "permissions.create", label: "Create Permission Modules", category: "Users & Permissions" },
  { key: "permissions.edit", label: "Edit Permission Modules", category: "Users & Permissions" },
  { key: "permissions.delete", label: "Delete Permission Modules", category: "Users & Permissions" },
  { key: "security_settings.view", label: "View Security Settings", category: "Users & Permissions" },
  { key: "security_settings.edit", label: "Edit Security Settings", category: "Users & Permissions" },
] as const;

export type PermissionKey = (typeof PERMISSIONS)[number]["key"];

const ALL_KEYS: readonly string[] = PERMISSIONS.map((p) => p.key);

export function isPermissionKey(value: string): value is PermissionKey {
  return ALL_KEYS.includes(value);
}

/** Every `.view`-suffixed key — the entire "Read Only" default Permission Module. */
export const READ_ONLY_PERMISSION_KEYS: readonly string[] = PERMISSIONS.filter((p) => p.key.endsWith(".view")).map(
  (p) => p.key,
);

/** Matches the spec's own illustrative example for this default module verbatim. */
export const SUPPORT_MANAGER_PERMISSION_KEYS: readonly string[] = [
  "messages.view",
  "automation_rules.view",
  "automation_rules.create",
  "automation_rules.edit",
  "automation_rules.activate",
  "automation_rules.bulk_import",
  "automation_rules.bulk_export",
  "users.view",
];

/** Matches the spec's own illustrative example for this default module verbatim. */
export const SUPPORT_AGENT_PERMISSION_KEYS: readonly string[] = [
  "messages.view",
  "automation_rules.view",
  "automation_rules.create",
  "automation_rules.edit",
];
