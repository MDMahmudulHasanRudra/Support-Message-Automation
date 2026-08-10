/**
 * Canonical string-literal enums shared across apps/web, apps/worker, and
 * packages/engine. packages/engine must not depend on the Prisma client
 * (it has to stay pure/testable without a DB), so these are the source of
 * truth; packages/db's Prisma schema enums are kept in sync with these by
 * convention (see packages/db/prisma/schema.prisma).
 */

export const MESSAGE_DIRECTION = ["INCOMING", "OUTGOING", "SYSTEM"] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTION)[number];

export const PROCESSING_STATUS = [
  "PENDING",
  "PROCESSED",
  "IGNORED",
  "FAILED",
] as const;
export type ProcessingStatus = (typeof PROCESSING_STATUS)[number];

export const RULE_STATUS = ["DRAFT", "ACTIVE", "DISABLED", "ARCHIVED"] as const;
export type RuleStatus = (typeof RULE_STATUS)[number];

/**
 * The unified AutomationRule model (see ARCHITECTURE.md) uses one shape for
 * every kind of rule; `type` is metadata for grouping/UI/priority defaults,
 * not a discriminator that changes the row's structure.
 */
export const RULE_TYPE = [
  "TEAM_FILTER",
  "DEFAULT_IGNORE",
  "LAST_SENDER",
  "EXCEPTION",
  "SUPPORT_ESCALATION",
  "AUTO_REPLY",
  "GENERIC",
] as const;
export type RuleType = (typeof RULE_TYPE)[number];

export const MATCH_TYPE = [
  "EXACT",
  "CONTAINS",
  "KEYWORDS",
  "REGEX",
  "ALWAYS",
] as const;
export type MatchType = (typeof MATCH_TYPE)[number];

export const ACTION_TYPE = [
  "IGNORE",
  "TAG",
  "AUTO_REPLY",
  "SUPPORT_REQUIRED",
  "NOTIFY_TEAMS",
  "NOTIFY_WHATSAPP",
  "FORWARD",
  "STOP_PROCESSING",
] as const;
export type ActionType = (typeof ACTION_TYPE)[number];

export const OUTBOUND_MESSAGE_STATUS = [
  "PENDING",
  "PROCESSING",
  "SENT",
  "FAILED",
  "CANCELLED",
  "RATE_LIMITED",
] as const;
export type OutboundMessageStatus = (typeof OUTBOUND_MESSAGE_STATUS)[number];

export const NOTIFICATION_TYPE = ["TEAMS", "WHATSAPP"] as const;
export type NotificationType = (typeof NOTIFICATION_TYPE)[number];

export const NOTIFICATION_STATUS = [
  "PENDING",
  "SENT",
  "FAILED",
  "RETRYING",
] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUS)[number];

export const WORKER_COMMAND_TYPE = [
  "GET_QR",
  "RECONNECT",
  "SEND_LIVE_TEST",
  "RESYNC_GROUPS",
] as const;
export type WorkerCommandType = (typeof WORKER_COMMAND_TYPE)[number];

export const WORKER_COMMAND_STATUS = [
  "PENDING",
  "PROCESSING",
  "DONE",
  "FAILED",
] as const;
export type WorkerCommandStatus = (typeof WORKER_COMMAND_STATUS)[number];

/**
 * Locked exactly to the master specification's three automation levels.
 * MANUAL_ONLY: detect + notify only, never auto-reply.
 * SAFE_AUTO_REPLY: only explicitly low-risk acknowledgement rules may reply. Default.
 * FULL_RULE_AUTOMATION: all active rules may execute, subject to safety limits.
 */
export const AUTOMATION_MODE = [
  "MANUAL_ONLY",
  "SAFE_AUTO_REPLY",
  "FULL_RULE_AUTOMATION",
] as const;
export type AutomationMode = (typeof AUTOMATION_MODE)[number];

export const TEAM_MEMBER_STATUS = ["ACTIVE", "INACTIVE"] as const;
export type TeamMemberStatus = (typeof TEAM_MEMBER_STATUS)[number];

export const WHATSAPP_ACCOUNT_STATUS = [
  "CONNECTED",
  "DISCONNECTED",
  "RECONNECTING",
  "AUTHENTICATION_REQUIRED",
  "SESSION_ERROR",
  "OUTBOUND_PAUSED",
  "RATE_LIMITED",
  "ERROR",
] as const;
export type WhatsAppAccountStatus = (typeof WHATSAPP_ACCOUNT_STATUS)[number];

export const LOG_LEVEL = ["INFO", "WARN", "ERROR"] as const;
export type LogLevel = (typeof LOG_LEVEL)[number];
