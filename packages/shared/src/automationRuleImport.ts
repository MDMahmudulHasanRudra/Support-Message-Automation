/**
 * Pure, DB-free logic for bulk-importing AutomationRule rows from an Excel file — mirrors
 * groupBroadcast.ts's exact shape (pure functions, no Prisma, no @support-automation/engine
 * dependency since packages/engine itself depends on packages/shared and a reverse dependency
 * would be circular). apps/web is responsible for reading the uploaded file via `xlsx`, running
 * the one check that genuinely can't live here (regex-safety, via packages/engine's
 * validateRegexSafety — see apps/web/src/server/actions/rules.ts's validateRuleBusinessRules()),
 * and the actual Prisma writes. Everything here just operates on plain data, which is what makes
 * it unit-testable at all — apps/web has no test runner of its own.
 */

import { ACTION_TYPE, MATCH_TYPE, RULE_TYPE } from "./enums.js";
import type { ActionType, MatchType, RuleType } from "./enums.js";
import type { RuleAction, RuleConditions } from "./rule-types.js";
// Reuses groupBroadcast.ts's own established Excel-upload limits directly (also re-exported from
// this package's index already) rather than redefining a second, potentially-drifting constant.
import { MAX_EXCEL_FILE_SIZE_BYTES, MAX_EXCEL_ROWS } from "./groupBroadcast.js";

/** Same reasoning as groupBroadcast.ts's own MAX_GROUP_NAME_LENGTH — a hard cap, not arbitrary. */
export const MAX_RULE_NAME_LENGTH = 256;

const SENDER_SCOPE_VALUES = ["ANY", "TEAM_MEMBER", "CLIENT"] as const;
type SenderScopeValue = (typeof SENDER_SCOPE_VALUES)[number];
const PREVIOUS_SENDER_SCOPE_VALUES = ["NONE", "ANY", "TEAM_MEMBER", "CLIENT"] as const;
type PreviousSenderScopeValue = (typeof PREVIOUS_SENDER_SCOPE_VALUES)[number];

/** GROUP_BROADCAST is never produced by the rule engine and isn't offered in the manual
 * RuleForm's action checkboxes either — excluded here for the same reason, not a new rule. */
const IMPORTABLE_ACTION_TYPES: ActionType[] = ACTION_TYPE.filter((a) => a !== "GROUP_BROADCAST");

export interface RuleImportRow {
  name: string;
  description: string | null;
  type: RuleType;
  matchType: MatchType;
  matchValue: string | null;
  keywords: string[];
  priority: number;
  actions: RuleAction[];
  replyMessage: string | null;
  cooldownSeconds: number | null;
  replyDelayMinMs: number | null;
  replyDelayMaxMs: number | null;
  conditions: RuleConditions;
}

export type RuleImportOutcome = "VALID" | "DUPLICATE_EXISTING" | "DUPLICATE_IN_FILE" | "INVALID";

export interface RuleImportRowResult {
  rowNumber: number; // 1-based, matching what a spreadsheet user sees (header = row 1)
  /** Present only when structural parsing succeeded — even a DUPLICATE_* row still has one, so a
   * duplicate can still be reviewed/edited later; only INVALID rows may have `row: null`. */
  row: RuleImportRow | null;
  outcome: RuleImportOutcome;
  /** Always populated — "Valid." for a clean row, otherwise the specific reason. */
  reason: string;
}

const COLUMN_LABELS = {
  name: "Name",
  description: "Description",
  type: "Type",
  matchType: "Match Type",
  matchValue: "Match Value",
  keywords: "Keywords",
  priority: "Priority",
  actions: "Actions",
  actionTag: "Action Tag",
  actionCategory: "Action Category",
  actionForwardChatId: "Action Forward Chat Id",
  replyMessage: "Reply Message",
  cooldownSeconds: "Cooldown Seconds",
  replyDelayMinMs: "Reply Delay Min Ms",
  replyDelayMaxMs: "Reply Delay Max Ms",
  senderScope: "Sender Scope",
  previousSenderScope: "Previous Sender Scope",
  groupScopeIds: "Group Scope Ids",
  timeWindowStartHour: "Time Window Start Hour",
  timeWindowEndHour: "Time Window End Hour",
  timeWindowDays: "Time Window Days",
} as const;

const REQUIRED_COLUMNS: Array<keyof typeof COLUMN_LABELS> = ["name", "type", "matchType", "actions"];

function normalizeHeader(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

/** Case/whitespace-tolerant column lookup — same convention as groupBroadcast.ts's own resolveColumnKey. */
function resolveColumnKey(sampleRow: Record<string, unknown>, wanted: string): string | null {
  const target = normalizeHeader(wanted);
  for (const key of Object.keys(sampleRow)) {
    if (normalizeHeader(key) === target) return key;
  }
  return null;
}

function cellString(raw: Record<string, unknown>, key: string | null | undefined): string {
  if (!key) return "";
  return String(raw[key] ?? "").trim();
}

function splitList(value: string): string[] {
  return value ? value.split(",").map((v) => v.trim()).filter(Boolean) : [];
}

function parseOptionalInt(value: string): { ok: true; value: number | null } | { ok: false } {
  if (!value) return { ok: true, value: null };
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return { ok: false };
  return { ok: true, value: n };
}

interface ResolvedColumnKeys {
  [field: string]: string | null;
}

function resolveAllColumnKeys(sampleRow: Record<string, unknown>): ResolvedColumnKeys {
  const keys: ResolvedColumnKeys = {};
  for (const [field, label] of Object.entries(COLUMN_LABELS)) {
    keys[field] = resolveColumnKey(sampleRow, label);
  }
  return keys;
}

/**
 * Parses and structurally validates one raw Excel row. Deliberately does NOT check regex safety
 * (packages/engine's validateRegexSafety) — that's the one check that must happen in apps/web
 * (see this file's own top doc comment for why) via the exact same validateRuleBusinessRules()
 * the manual Create/Edit Rule form already uses. Returns the first blocking problem found, same
 * "one error at a time" convention the manual form's own validation already follows.
 */
function parseRow(raw: Record<string, unknown>, rowNumber: number, keys: ResolvedColumnKeys): RuleImportRowResult {
  const fail = (reason: string): RuleImportRowResult => ({ rowNumber, row: null, outcome: "INVALID", reason });

  const name = cellString(raw, keys.name);
  if (!name) return fail("Missing required field: Name.");
  if (name.length > MAX_RULE_NAME_LENGTH) return fail(`Name exceeds ${MAX_RULE_NAME_LENGTH} characters.`);

  const typeRaw = cellString(raw, keys.type);
  if (!typeRaw) return fail("Missing required field: Type.");
  if (!(RULE_TYPE as readonly string[]).includes(typeRaw)) {
    return fail(`Invalid Type "${typeRaw}" — must be one of: ${RULE_TYPE.join(", ")}.`);
  }

  const matchTypeRaw = cellString(raw, keys.matchType);
  if (!matchTypeRaw) return fail("Missing required field: Match Type.");
  if (!(MATCH_TYPE as readonly string[]).includes(matchTypeRaw)) {
    return fail(`Invalid Match Type "${matchTypeRaw}" — must be one of: ${MATCH_TYPE.join(", ")}.`);
  }
  const matchType = matchTypeRaw as MatchType;

  const matchValue = cellString(raw, keys.matchValue) || null;
  // Structural presence check only (mirrors validateIfRegex's own "requires a pattern" half) —
  // the actual safety check on the pattern itself happens later, in apps/web.
  if (matchType === "REGEX" && !matchValue) return fail("A REGEX rule requires a Match Value.");

  const keywords = splitList(cellString(raw, keys.keywords));

  const priorityRaw = cellString(raw, keys.priority);
  const priorityParsed = parseOptionalInt(priorityRaw);
  if (!priorityParsed.ok) return fail(`Invalid Priority "${priorityRaw}" — must be a whole number.`);
  const priority = priorityParsed.value ?? 0;

  const actionsRaw = cellString(raw, keys.actions);
  if (!actionsRaw) return fail("Missing required field: Actions.");
  const actionTokens = splitList(actionsRaw);
  const invalidActionToken = actionTokens.find((t) => !IMPORTABLE_ACTION_TYPES.includes(t as ActionType));
  if (invalidActionToken) {
    return fail(`Invalid action "${invalidActionToken}" — must be one of: ${IMPORTABLE_ACTION_TYPES.join(", ")}.`);
  }
  if (actionTokens.length === 0) return fail("At least one action is required.");

  const actions: RuleAction[] = actionTokens.map((type) => {
    const action: RuleAction = { type: type as ActionType };
    if (type === "TAG") action.tag = cellString(raw, keys.actionTag) || undefined;
    if (type === "SUPPORT_REQUIRED") action.category = cellString(raw, keys.actionCategory) || undefined;
    if (type === "FORWARD") action.forwardToChatId = cellString(raw, keys.actionForwardChatId) || undefined;
    return action;
  });

  const cooldownParsed = parseOptionalInt(cellString(raw, keys.cooldownSeconds));
  if (!cooldownParsed.ok) return fail("Invalid Cooldown Seconds — must be a whole number.");
  const replyDelayMinParsed = parseOptionalInt(cellString(raw, keys.replyDelayMinMs));
  if (!replyDelayMinParsed.ok) return fail("Invalid Reply Delay Min Ms — must be a whole number.");
  const replyDelayMaxParsed = parseOptionalInt(cellString(raw, keys.replyDelayMaxMs));
  if (!replyDelayMaxParsed.ok) return fail("Invalid Reply Delay Max Ms — must be a whole number.");

  const senderScopeRaw = cellString(raw, keys.senderScope) || "ANY";
  if (!(SENDER_SCOPE_VALUES as readonly string[]).includes(senderScopeRaw)) {
    return fail(`Invalid Sender Scope "${senderScopeRaw}" — must be one of: ${SENDER_SCOPE_VALUES.join(", ")}.`);
  }
  const previousSenderScopeRaw = cellString(raw, keys.previousSenderScope) || "NONE";
  if (!(PREVIOUS_SENDER_SCOPE_VALUES as readonly string[]).includes(previousSenderScopeRaw)) {
    return fail(`Invalid Previous Sender Scope "${previousSenderScopeRaw}" — must be one of: ${PREVIOUS_SENDER_SCOPE_VALUES.join(", ")}.`);
  }
  const groupScopeIds = splitList(cellString(raw, keys.groupScopeIds));

  const startHourRaw = cellString(raw, keys.timeWindowStartHour);
  const endHourRaw = cellString(raw, keys.timeWindowEndHour);
  let timeWindow: RuleConditions["timeWindow"];
  if (startHourRaw || endHourRaw) {
    if (!startHourRaw || !endHourRaw) {
      return fail("Time Window Start Hour and Time Window End Hour must both be set together, or both left blank.");
    }
    const startParsed = parseOptionalInt(startHourRaw);
    const endParsed = parseOptionalInt(endHourRaw);
    if (!startParsed.ok || startParsed.value === null || startParsed.value < 0 || startParsed.value > 23) {
      return fail("Invalid Time Window Start Hour — must be a whole number 0-23.");
    }
    if (!endParsed.ok || endParsed.value === null || endParsed.value < 0 || endParsed.value > 23) {
      return fail("Invalid Time Window End Hour — must be a whole number 0-23.");
    }
    if (startParsed.value === endParsed.value) {
      return fail("Time Window Start Hour and End Hour cannot be the same — this would never match. Leave Status as Draft and skip the schedule instead.");
    }
    const daysRaw = splitList(cellString(raw, keys.timeWindowDays));
    const days = daysRaw.map(Number);
    if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      return fail("Invalid Time Window Days — must be comma-separated whole numbers 0-6 (0=Sunday).");
    }
    timeWindow = { startHour: startParsed.value, endHour: endParsed.value, ...(days.length > 0 ? { days } : {}) };
  }

  const conditions: RuleConditions = {};
  if (senderScopeRaw !== "ANY") conditions.sender = { type: senderScopeRaw as SenderScopeValue };
  if (previousSenderScopeRaw !== "NONE") conditions.previousSender = { type: previousSenderScopeRaw as Exclude<PreviousSenderScopeValue, "NONE"> };
  if (groupScopeIds.length > 0) conditions.groupScope = { type: "SPECIFIC", groupIds: groupScopeIds };
  if (timeWindow) conditions.timeWindow = timeWindow;

  const row: RuleImportRow = {
    name,
    description: cellString(raw, keys.description) || null,
    type: typeRaw as RuleType,
    matchType,
    matchValue,
    keywords,
    priority,
    actions,
    replyMessage: cellString(raw, keys.replyMessage) || null,
    cooldownSeconds: cooldownParsed.value,
    replyDelayMinMs: replyDelayMinParsed.value,
    replyDelayMaxMs: replyDelayMaxParsed.value,
    conditions,
  };

  return { rowNumber, row, outcome: "VALID", reason: "Valid." };
}

export interface RuleImportParseResult {
  results: RuleImportRowResult[];
  /** File-level problems (missing columns, too many rows, empty file) — nothing was parsed at all. */
  fileErrors: string[];
}

/**
 * Parses every row structurally (required fields, enum membership, numeric ranges) and flags
 * in-file duplicate names (case-insensitive, trimmed) — everything a pure function can determine
 * without touching the database. apps/web layers two more checks on top per row that already
 * passed here: regex safety (if matchType is REGEX) and duplicate-against-existing-database-rows.
 */
export function parseRuleImportRows(rawRows: Array<Record<string, unknown>>): RuleImportParseResult {
  if (rawRows.length === 0) {
    return { results: [], fileErrors: ["The file has no data rows."] };
  }
  if (rawRows.length > MAX_EXCEL_ROWS) {
    return {
      results: [],
      fileErrors: [`The file has ${rawRows.length} rows, which exceeds the maximum of ${MAX_EXCEL_ROWS}. Split it into smaller files.`],
    };
  }

  const keys = resolveAllColumnKeys(rawRows[0]!);
  const missing = REQUIRED_COLUMNS.filter((field) => !keys[field]).map((field) => COLUMN_LABELS[field]);
  if (missing.length > 0) {
    return { results: [], fileErrors: [`Missing required column(s): ${missing.join(", ")}.`] };
  }

  const seenNames = new Set<string>();
  const results: RuleImportRowResult[] = rawRows.map((raw, index) => {
    const rowNumber = index + 2; // +1 for 1-based, +1 for the header row
    const parsed = parseRow(raw, rowNumber, keys);
    if (parsed.outcome !== "VALID" || !parsed.row) return parsed;

    const normalizedName = parsed.row.name.trim().toLowerCase();
    if (seenNames.has(normalizedName)) {
      return { ...parsed, outcome: "DUPLICATE_IN_FILE", reason: `"${parsed.row.name}" appears more than once in this file — only the first occurrence will be created.` };
    }
    seenNames.add(normalizedName);
    return parsed;
  });

  return { results, fileErrors: [] };
}

/** Two realistic example rows for the downloadable "Download Template" file — this IS the demo
 * file, generated fresh from the real schema/enum values rather than a static asset that could
 * drift out of sync. XLSX.utils.json_to_sheet derives the header row from these objects' own keys
 * (in insertion order), so no separate header row is built here. */
export function buildRuleImportTemplateRows(): Array<Record<string, string | number>> {
  const example1: Record<string, string | number> = {
    [COLUMN_LABELS.name]: "Greeting Auto-Reply",
    [COLUMN_LABELS.description]: "Replies to a simple hello",
    [COLUMN_LABELS.type]: "AUTO_REPLY",
    [COLUMN_LABELS.matchType]: "KEYWORDS",
    [COLUMN_LABELS.matchValue]: "",
    [COLUMN_LABELS.keywords]: "hello, hi, hey",
    [COLUMN_LABELS.priority]: 10,
    [COLUMN_LABELS.actions]: "AUTO_REPLY",
    [COLUMN_LABELS.actionTag]: "",
    [COLUMN_LABELS.actionCategory]: "",
    [COLUMN_LABELS.actionForwardChatId]: "",
    [COLUMN_LABELS.replyMessage]: "Hi! How can we help you today?",
    [COLUMN_LABELS.cooldownSeconds]: 3600,
    [COLUMN_LABELS.replyDelayMinMs]: 2000,
    [COLUMN_LABELS.replyDelayMaxMs]: 8000,
    [COLUMN_LABELS.senderScope]: "CLIENT",
    [COLUMN_LABELS.previousSenderScope]: "NONE",
    [COLUMN_LABELS.groupScopeIds]: "",
    [COLUMN_LABELS.timeWindowStartHour]: "",
    [COLUMN_LABELS.timeWindowEndHour]: "",
    [COLUMN_LABELS.timeWindowDays]: "",
  };
  const example2: Record<string, string | number> = {
    [COLUMN_LABELS.name]: "Internet Slow — Escalate",
    [COLUMN_LABELS.description]: "Flags a connectivity complaint for support",
    [COLUMN_LABELS.type]: "SUPPORT_ESCALATION",
    [COLUMN_LABELS.matchType]: "CONTAINS",
    [COLUMN_LABELS.matchValue]: "internet slow",
    [COLUMN_LABELS.keywords]: "",
    [COLUMN_LABELS.priority]: 50,
    [COLUMN_LABELS.actions]: "SUPPORT_REQUIRED, NOTIFY_TEAMS",
    [COLUMN_LABELS.actionTag]: "",
    [COLUMN_LABELS.actionCategory]: "INTERNET_ISSUE",
    [COLUMN_LABELS.actionForwardChatId]: "",
    [COLUMN_LABELS.replyMessage]: "",
    [COLUMN_LABELS.cooldownSeconds]: "",
    [COLUMN_LABELS.replyDelayMinMs]: "",
    [COLUMN_LABELS.replyDelayMaxMs]: "",
    [COLUMN_LABELS.senderScope]: "ANY",
    [COLUMN_LABELS.previousSenderScope]: "NONE",
    [COLUMN_LABELS.groupScopeIds]: "",
    [COLUMN_LABELS.timeWindowStartHour]: "",
    [COLUMN_LABELS.timeWindowEndHour]: "",
    [COLUMN_LABELS.timeWindowDays]: "",
  };
  return [example1, example2];
}

export interface RuleExportInput {
  name: string;
  description: string | null;
  type: string;
  matchType: string;
  matchValue: string | null;
  keywords: string[];
  priority: number;
  status: string;
  actions: RuleAction[];
  conditions: RuleConditions;
  replyMessage: string | null;
  cooldownSeconds: number | null;
  replyDelayMinMs: number | null;
  replyDelayMaxMs: number | null;
  executionCount: number;
  updatedAt: Date;
}

/** The reverse of parseRow() — flattens a real AutomationRule back into the same column shape the
 * import template uses (plus Status/Execution Count/Last Modified, which import never sets but
 * export always shows), so an exported file can be edited and re-imported directly. Caller
 * (apps/web) is responsible for running this through sanitizeExcelCell (excelSafety.ts) before
 * writing to a workbook — this function only shapes the data, it doesn't sanitize it. */
export function buildRuleExportRow(rule: RuleExportInput): Record<string, string | number> {
  const tagAction = rule.actions.find((a) => a.type === "TAG");
  const categoryAction = rule.actions.find((a) => a.type === "SUPPORT_REQUIRED");
  const forwardAction = rule.actions.find((a) => a.type === "FORWARD");

  return {
    [COLUMN_LABELS.name]: rule.name,
    [COLUMN_LABELS.description]: rule.description ?? "",
    [COLUMN_LABELS.type]: rule.type,
    [COLUMN_LABELS.matchType]: rule.matchType,
    [COLUMN_LABELS.matchValue]: rule.matchValue ?? "",
    [COLUMN_LABELS.keywords]: rule.keywords.join(", "),
    [COLUMN_LABELS.priority]: rule.priority,
    "Status": rule.status,
    [COLUMN_LABELS.actions]: rule.actions.map((a) => a.type).join(", "),
    [COLUMN_LABELS.actionTag]: tagAction?.tag ?? "",
    [COLUMN_LABELS.actionCategory]: categoryAction?.category ?? "",
    [COLUMN_LABELS.actionForwardChatId]: forwardAction?.forwardToChatId ?? "",
    [COLUMN_LABELS.replyMessage]: rule.replyMessage ?? "",
    [COLUMN_LABELS.cooldownSeconds]: rule.cooldownSeconds ?? "",
    [COLUMN_LABELS.replyDelayMinMs]: rule.replyDelayMinMs ?? "",
    [COLUMN_LABELS.replyDelayMaxMs]: rule.replyDelayMaxMs ?? "",
    [COLUMN_LABELS.senderScope]: rule.conditions.sender?.type ?? "ANY",
    [COLUMN_LABELS.previousSenderScope]: rule.conditions.previousSender?.type ?? "NONE",
    [COLUMN_LABELS.groupScopeIds]: rule.conditions.groupScope?.groupIds?.join(", ") ?? "",
    [COLUMN_LABELS.timeWindowStartHour]: rule.conditions.timeWindow?.startHour ?? "",
    [COLUMN_LABELS.timeWindowEndHour]: rule.conditions.timeWindow?.endHour ?? "",
    [COLUMN_LABELS.timeWindowDays]: rule.conditions.timeWindow?.days?.join(", ") ?? "",
    "Execution Count": rule.executionCount,
    "Last Modified": rule.updatedAt.toISOString(),
  };
}
