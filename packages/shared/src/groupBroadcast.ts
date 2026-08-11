/**
 * Pure, DB-free logic for the Group Message Sender's Excel import and group
 * matching (see ARCHITECTURE.md-style rationale: this stays testable without
 * xlsx or Prisma, same reason packages/engine's rule matching is pure).
 * apps/web is responsible for turning an uploaded file into plain row
 * objects (via the `xlsx` library) and for loading the candidate groups from
 * Postgres — everything here just operates on plain data.
 */

export const REQUIRED_EXCEL_COLUMN = "Group Name";
export const OPTIONAL_EXCEL_COLUMN = "Message";

/** Hard caps enforced before any parsing — "excessively large files" must be rejected, not truncated silently. */
export const MAX_EXCEL_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_EXCEL_ROWS = 2000;
export const MAX_MESSAGE_LENGTH = 4096;
export const MAX_GROUP_NAME_LENGTH = 256;

// eslint-disable-next-line no-control-regex -- deliberately matching control characters to reject them
const CONTROL_CHAR_PATTERN = /[\x00-\x1F\x7F]/;
// Zero-width space/joiners + BOM — invisible characters that would otherwise defeat exact-name matching silently.
const INVISIBLE_CHAR_PATTERN = /[​‌‍﻿]/g;

export interface ExcelGroupRow {
  rowNumber: number; // 1-based, matching the row a spreadsheet user would see (header = row 1)
  groupName: string; // trimmed, original casing preserved for display
  message: string | null; // trimmed; null if the Message column was blank/absent for this row
}

export interface ExcelParseResult {
  rows: ExcelGroupRow[];
  /** File-level or row-level problems severe enough that the affected row(s) were dropped entirely. */
  errors: string[];
}

function normalizeHeader(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

/** Finds the actual column key in a parsed sheet row, tolerant of header casing/whitespace but not of missing columns. */
function resolveColumnKey(sampleRow: Record<string, unknown>, wanted: string): string | null {
  const target = normalizeHeader(wanted);
  for (const key of Object.keys(sampleRow)) {
    if (normalizeHeader(key) === target) return key;
  }
  return null;
}

/**
 * Validates and normalizes rows already parsed out of an .xlsx sheet (i.e.
 * the array `xlsx`'s `sheet_to_json` produces) into the shape the rest of
 * the Group Message Sender works with. Never silently drops a malformed row
 * without recording why in `errors`.
 */
export function parseExcelRows(rawRows: Array<Record<string, unknown>>): ExcelParseResult {
  const errors: string[] = [];

  if (rawRows.length === 0) {
    return { rows: [], errors: ["The file has no data rows."] };
  }
  if (rawRows.length > MAX_EXCEL_ROWS) {
    return {
      rows: [],
      errors: [`The file has ${rawRows.length} rows, which exceeds the maximum of ${MAX_EXCEL_ROWS}. Split it into smaller files.`],
    };
  }

  const groupNameKey = resolveColumnKey(rawRows[0]!, REQUIRED_EXCEL_COLUMN);
  if (!groupNameKey) {
    return { rows: [], errors: [`Missing required column "${REQUIRED_EXCEL_COLUMN}".`] };
  }
  const messageKey = resolveColumnKey(rawRows[0]!, OPTIONAL_EXCEL_COLUMN);

  const rows: ExcelGroupRow[] = [];

  rawRows.forEach((raw, index) => {
    const rowNumber = index + 2; // +1 for 1-based, +1 for the header row
    const groupNameRaw = String(raw[groupNameKey] ?? "").trim();
    const messageRaw = messageKey ? String(raw[messageKey] ?? "").trim() : "";

    if (!groupNameRaw) {
      errors.push(`Row ${rowNumber}: empty "${REQUIRED_EXCEL_COLUMN}" -- skipped.`);
      return;
    }
    if (groupNameRaw.length > MAX_GROUP_NAME_LENGTH) {
      errors.push(`Row ${rowNumber}: group name exceeds ${MAX_GROUP_NAME_LENGTH} characters -- skipped.`);
      return;
    }
    if (CONTROL_CHAR_PATTERN.test(groupNameRaw)) {
      errors.push(`Row ${rowNumber}: group name contains invalid control characters -- skipped.`);
      return;
    }
    if (messageRaw.length > MAX_MESSAGE_LENGTH) {
      errors.push(`Row ${rowNumber}: message exceeds ${MAX_MESSAGE_LENGTH} characters -- skipped.`);
      return;
    }

    rows.push({ rowNumber, groupName: groupNameRaw, message: messageRaw || null });
  });

  return { rows, errors };
}

/**
 * Controlled normalization ONLY (case, whitespace, invisible characters) --
 * deliberately no fuzzy/distance-based matching. Per the safety requirement,
 * an ambiguous or near-miss name must never be auto-selected.
 */
export function normalizeGroupName(name: string): string {
  return name
    .replace(INVISIBLE_CHAR_PATTERN, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export interface GroupCandidate {
  id: string;
  name: string;
}

export type GroupMatchStatus = "MATCHED" | "UNMATCHED" | "AMBIGUOUS" | "DUPLICATE";

export interface GroupMatchResult {
  rowNumber: number;
  groupName: string;
  message: string | null;
  status: GroupMatchStatus;
  /** Set only when status === "MATCHED". */
  matchedGroupId: string | null;
  matchedGroupName: string | null;
  /** Set only when status === "AMBIGUOUS" -- the candidates a human must choose between. */
  ambiguousCandidates: GroupCandidate[];
  reason: string;
}

/**
 * Matches Excel rows against already-synchronized WhatsApp groups.
 * Two tiers only, both exact after normalization -- no fuzzy matching:
 *   1. Exact raw name match (fast path, most common case).
 *   2. Normalized match (case/whitespace-insensitive); if more than one
 *      candidate shares the same normalized name, that's AMBIGUOUS, never a
 *      silent pick.
 * A group name repeated within the same file (by normalized name) is
 * flagged DUPLICATE for every occurrence after the first -- the first
 * occurrence is matched normally so it isn't dropped outright.
 */
export function matchExcelGroups(rows: ExcelGroupRow[], candidates: GroupCandidate[]): GroupMatchResult[] {
  const byExactName = new Map<string, GroupCandidate[]>();
  const byNormalizedName = new Map<string, GroupCandidate[]>();
  for (const candidate of candidates) {
    pushInto(byExactName, candidate.name, candidate);
    pushInto(byNormalizedName, normalizeGroupName(candidate.name), candidate);
  }

  const seenNormalizedNames = new Set<string>();
  const results: GroupMatchResult[] = [];

  for (const row of rows) {
    const normalized = normalizeGroupName(row.groupName);
    const base = { rowNumber: row.rowNumber, groupName: row.groupName, message: row.message };

    if (seenNormalizedNames.has(normalized)) {
      results.push({
        ...base,
        status: "DUPLICATE",
        matchedGroupId: null,
        matchedGroupName: null,
        ambiguousCandidates: [],
        reason: `"${row.groupName}" appears more than once in this file -- only the first occurrence is queued.`,
      });
      continue;
    }
    seenNormalizedNames.add(normalized);

    const exact = byExactName.get(row.groupName) ?? [];
    if (exact.length === 1) {
      results.push({
        ...base,
        status: "MATCHED",
        matchedGroupId: exact[0]!.id,
        matchedGroupName: exact[0]!.name,
        ambiguousCandidates: [],
        reason: "Exact name match.",
      });
      continue;
    }

    const normalizedMatches = byNormalizedName.get(normalized) ?? [];
    if (normalizedMatches.length === 1) {
      results.push({
        ...base,
        status: "MATCHED",
        matchedGroupId: normalizedMatches[0]!.id,
        matchedGroupName: normalizedMatches[0]!.name,
        ambiguousCandidates: [],
        reason: "Matched after normalizing case/whitespace.",
      });
      continue;
    }

    if (normalizedMatches.length > 1) {
      results.push({
        ...base,
        status: "AMBIGUOUS",
        matchedGroupId: null,
        matchedGroupName: null,
        ambiguousCandidates: normalizedMatches,
        reason: `${normalizedMatches.length} synchronized groups share this name -- manual selection required.`,
      });
      continue;
    }

    results.push({
      ...base,
      status: "UNMATCHED",
      matchedGroupId: null,
      matchedGroupName: null,
      ambiguousCandidates: [],
      reason: "No synchronized WhatsApp group has this name. Resync groups or check spelling.",
    });
  }

  return results;
}

function pushInto<K>(map: Map<K, GroupCandidate[]>, key: K, value: GroupCandidate): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

/** Shared validation for the message that will actually be sent (resolved common/per-row text), used both client-preview-side and server-side before queueing. */
export function validateMessageText(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return "Message cannot be empty.";
  if (trimmed.length > MAX_MESSAGE_LENGTH) return `Message exceeds ${MAX_MESSAGE_LENGTH} characters.`;
  return null;
}

/**
 * One outbound row per (broadcast job, target group) pair -- only apps/web
 * ever builds this (at job-creation time); apps/worker only relies on the
 * unique DB constraint it enforces, never reconstructs it. Lives here
 * rather than duplicated in each app, same reasoning as the rest of this
 * file: a worker restart between "job created" and "all rows queued", or a
 * duplicate job-creation call, can never queue the same group twice.
 */
export function buildGroupBroadcastIdempotencyKey(params: { broadcastJobId: string; groupId: string }): string {
  return `broadcast:${params.broadcastJobId}:${params.groupId}`;
}

/** Same jitter approach as apps/worker/src/pipeline/enqueueOutbound.ts's randomDelayMs, shared since apps/web needs it too when spacing out a new job's queued rows. */
export function randomDelayMs(minMs: number, maxMs: number): number {
  if (maxMs <= minMs) return minMs;
  return minMs + Math.floor(Math.random() * (maxMs - minMs));
}
