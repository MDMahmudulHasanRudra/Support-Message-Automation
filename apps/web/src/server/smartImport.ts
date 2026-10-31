import * as XLSX from "xlsx";
import {
  assessSmartFile,
  autoMapSmart,
  buildSmartRows,
  detectHeaderRow,
  findInFileDuplicates,
  gridToRecords,
  inspectXlsxZip,
  looksLikeText,
  SMART_FIELD_KEYS,
  SMART_IMPORT_LIMITS,
  SMART_REVIEW_ORDER,
  SMART_SAMPLE_VALUES,
  upgradeMapping,
  type ClientImportFieldKey,
  type FieldIssue,
  type ImportedClientRow,
  type RowMoney,
  type FileAssessment,
  type SheetRecords,
  type SmartMapping,
  type SmartSamples,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { activeDisabledFeatures } from "@/server/projectFeatures";
import { loadExistingMatches } from "@/server/clientRecords";
import { loadImportLookups, resolveImportExtras, resolveRows, type ResolvedImportRow } from "@/server/clientImportExtras";
import { matchOf } from "@/server/clientImport";

/**
 * Smart Bulk Import (SMART_IMPORT.md), the server side that is not a "use server" file: reading a
 * workbook safely, the project's sample values, and the review analysis. The analysis is DERIVED from
 * the staged rows, the mapping and the database on every read — never stored — and cached briefly per
 * job revision so paging through the review does not recompute it.
 */

export async function smartImportEnabled(): Promise<boolean> {
  const disabled = await activeDisabledFeatures();
  return !disabled.has("CLIENT_SMART_IMPORT") && !disabled.has("CLIENT_CENTER");
}

export const SMART_IMPORT_OFF = "Smart Bulk Import is not switched on for this project.";

// ── Reading a workbook ─────────────────────────────────────────────────────────────────────────

export interface ParsedUpload {
  sheetNames: string[];
  sheetName: string;
  /** 1-based, as a person counts rows. */
  headerRow: number;
  records: SheetRecords;
  /** The first rows of the sheet as read, for choosing the header row. */
  topRows: string[][];
  /**
   * Why this sheet was opened when the person did not choose one and the file has several: the first sheet
   * of many workbooks is a cover or instructions page, and reading it gave "0 rows" (V5 §11). Null = the only
   * sheet, or the one the person chose.
   */
  sheetReason: string | null;
}

/**
 * Which sheet holds the client list, judged from each sheet's first rows: how many of its headers are client
 * fields this import recognises, and how many rows are filled under them. The first sheet wins ties, so a file
 * whose first sheet is the list behaves exactly as before.
 */
export function scoreSheet(grid: readonly (readonly string[])[]): { score: number; rows: number; recognised: number } {
  if (!grid.some((r) => r.some(Boolean))) return { score: 0, rows: 0, recognised: 0 };
  const headerIndex = detectHeaderRow(grid);
  const headers = (grid[headerIndex] ?? []).map((c) => String(c ?? "").trim()).filter(Boolean);
  const recognised = Object.keys(autoMapSmart(headers).mapping.fields).length;
  const rows = grid.slice(headerIndex + 1).filter((r) => r.filter(Boolean).length >= 2).length;
  return { score: (rows > 0 ? recognised * 10 : 0) + Math.min(rows, 20), rows, recognised };
}

const READ_OPTIONS = { cellFormula: false, cellHTML: false, cellStyles: false, cellText: true, cellDates: true, bookVBA: false, WTF: false } as const;

/** A cell as text, the way a person reads it: whole numbers never in exponent form, dates as YYYY-MM-DD. */
function cellText(cell: XLSX.CellObject | undefined): string {
  if (!cell || cell.v === undefined || cell.v === null) return "";
  if (cell.t === "d" && cell.v instanceof Date) return Number.isNaN(cell.v.getTime()) ? "" : cell.v.toISOString().slice(0, 10);
  // A phone number typed as a number shows as 8.80171E+12 in General format: keep its digits.
  if (cell.t === "n" && typeof cell.v === "number" && Number.isInteger(cell.v) && (!cell.z || cell.z === "General")) return String(cell.v);
  if (cell.t === "e") return "";
  return String(cell.w ?? cell.v);
}

function sheetGrid(sheet: XLSX.WorkSheet): string[][] {
  if (!sheet["!ref"]) return [];
  const range = XLSX.utils.decode_range(sheet["!ref"]);
  const lastRow = Math.min(range.e.r, range.s.r + SMART_IMPORT_LIMITS.maxRows + SMART_IMPORT_LIMITS.maxHeaderRow + 1);
  // One column past the limit is read so that gridToRecords can refuse the sheet rather than cut it.
  const lastCol = Math.min(range.e.c, range.s.c + SMART_IMPORT_LIMITS.maxColumns);
  const grid: string[][] = [];
  const dense = (sheet as { "!data"?: XLSX.CellObject[][] })["!data"];
  for (let r = range.s.r; r <= lastRow; r++) {
    const row: string[] = [];
    for (let c = range.s.c; c <= lastCol; c++) row.push(cellText(dense ? dense[r]?.[c] : sheet[XLSX.utils.encode_cell({ r, c })]));
    grid.push(row);
  }
  return grid;
}

/**
 * The upload, checked and read. Formulas, macros and links are never run: only the values the file
 * already holds are read. A zip that would expand beyond the limits is refused before it is opened.
 */
export function parseUpload(buffer: Buffer, fileName: string, choice: { sheet?: string | null; headerRow?: number | null } = {}): ParsedUpload | { error: string } {
  const lower = fileName.toLowerCase();
  const isCsv = lower.endsWith(".csv");
  if (!isCsv && !lower.endsWith(".xlsx")) return { error: "Only .xlsx and .csv files can be imported. In Excel, use File → Save As → Excel Workbook (.xlsx) or CSV." };
  if (buffer.length === 0) return { error: "The file is empty." };
  if (buffer.length > SMART_IMPORT_LIMITS.maxBytes) return { error: `That file is ${(buffer.length / 1024 / 1024).toFixed(1)} MB. The limit is ${SMART_IMPORT_LIMITS.maxBytes / 1024 / 1024} MB.` };

  let workbook: XLSX.WorkBook;
  let sheetReason: string | null = null;
  const sheetRows = SMART_IMPORT_LIMITS.maxRows + SMART_IMPORT_LIMITS.maxHeaderRow + 2;
  try {
    if (isCsv) {
      if (!looksLikeText(buffer)) return { error: "This file is not a text CSV. Save it from Excel as CSV (UTF-8) and try again." };
      const text = new TextDecoder("utf-8").decode(buffer).replace(/^﻿/, "");
      // raw: every cell stays the text it was written as — a phone keeps its leading zero.
      workbook = XLSX.read(text, { type: "string", raw: true, sheetRows, dense: true, ...READ_OPTIONS });
    } else {
      const zip = inspectXlsxZip(buffer);
      if (!zip.ok) return { error: zip.error };
      const names = XLSX.read(buffer, { type: "buffer", bookSheets: true }).SheetNames;
      let wanted = choice.sheet && names.includes(choice.sheet) ? choice.sheet : undefined;
      if (!wanted && names.length > 1) {
        // Only the top of each sheet is read to choose (bounded), then the chosen sheet is read whole.
        const peek = XLSX.read(buffer, { type: "buffer", sheetRows: 30, dense: true, sheets: names.slice(0, 50), ...READ_OPTIONS });
        let best = { name: names[0]!, score: -1, rows: 0, recognised: 0 };
        for (const name of names.slice(0, 50)) {
          const ws = peek.Sheets[name];
          const s = ws ? scoreSheet(sheetGrid(ws)) : { score: 0, rows: 0, recognised: 0 };
          if (s.score > best.score) best = { name, ...s };
        }
        wanted = best.name;
        if (best.name !== names[0]) sheetReason = `Opened the sheet "${best.name}": its columns look like a client list (${best.recognised} recognised), and "${names[0]}" does not. Change the sheet if that is wrong.`;
      }
      workbook = XLSX.read(buffer, { type: "buffer", sheetRows, dense: true, sheets: wanted ?? names[0], ...READ_OPTIONS });
      workbook.SheetNames = names;
    }
  } catch {
    return { error: "That file could not be read. It may be damaged; open it in Excel, save it as .xlsx or .csv, and try again." };
  }
  const sheetNames = workbook.SheetNames.slice(0, 50);
  const sheetName = choice.sheet && sheetNames.includes(choice.sheet) ? choice.sheet : (Object.keys(workbook.Sheets).find((n) => sheetNames.includes(n)) ?? sheetNames[0]);
  const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;
  if (!sheetName || !sheet) return { error: "The file has no sheet to read." };
  const grid = sheetGrid(sheet);
  if (!grid.some((row) => row.some(Boolean))) return { error: `The sheet "${sheetName}" is empty.${sheetNames.length > 1 ? " Choose another sheet." : ""}` };
  const headerIndex =
    choice.headerRow && choice.headerRow >= 1 && choice.headerRow <= SMART_IMPORT_LIMITS.maxHeaderRow ? choice.headerRow - 1 : detectHeaderRow(grid);
  const records = gridToRecords(grid, headerIndex);
  if ("error" in records) return records;
  return { sheetNames, sheetName, headerRow: headerIndex + 1, records, topRows: grid.slice(0, 8).map((r) => r.slice(0, 12).map((c) => c.slice(0, 60))), sheetReason };
}

// ── Sample values ──────────────────────────────────────────────────────────────────────────────

/** The software's sample values, with the roster fields filled from THIS project's own active people and teams. */
export async function projectSamples(): Promise<SmartSamples> {
  const [team, member] = await Promise.all([
    prisma.team.findFirst({ where: { status: "ACTIVE" }, orderBy: { name: "asc" }, select: { name: true } }),
    prisma.internalTeamMember.findFirst({ where: { status: "ACTIVE" }, orderBy: { name: "asc" }, select: { name: true, teamId: true, team: { select: { name: true, status: true } } } }),
  ]);
  return {
    ...SMART_SAMPLE_VALUES,
    team: member?.team?.status === "ACTIVE" ? member.team.name : (team?.name ?? ""),
    soldBy: member?.name ?? "",
    assignedTo: member?.name ?? "",
    startDate: new Date().toISOString().slice(0, 10),
  };
}

// ── The review analysis ────────────────────────────────────────────────────────────────────────

export type RowStatus = "NEW" | "MATCH" | "REPEAT" | "INVALID" | "IGNORED" | "BLANK";

export interface RowAnalysis {
  id: string;
  rowNumber: number;
  status: RowStatus;
  errors: string[];
  matchedClientId?: string;
  repeatsRow?: number;
  output: Record<ClientImportFieldKey, string>;
  edited: ClientImportFieldKey[];
  hasSubscription: boolean;
  /** Problems and notes, each on the field it concerns — the grid colours that cell, not the row. */
  issues: FieldIssue[];
  /** How the row's expiry was reached ("Calculated from Start date + 9 months"), when it has one. */
  expiryBasis: string | null;
  /** An expiry with no start date, recorded on the client rather than as a subscription. */
  recordedExpiry: boolean;
  /** V5 §7: the amounts this row states (null = no money mapping). Recorded only, never billed. */
  money: RowMoney | null;
  /** V5 §5: values filled from the phone number / country, not the file ("Auto selected"). */
  derived: Partial<Record<"country" | "currency" | "language", string>>;
  /** V5 §4: numbers kept as written because they could not be read with certainty. */
  phoneNotes: Array<{ field: "phone" | "whatsapp"; note: string }>;
}

export interface SmartSummary {
  total: number;
  ready: number;
  willCreate: number;
  matchExisting: number;
  repeats: number;
  invalid: number;
  ignored: number;
  blank: number;
  subscriptionRows: number;
}

export interface SmartAnalysis {
  revision: number;
  rows: RowAnalysis[];
  summary: SmartSummary;
  assessment: FileAssessment;
  /** Every import field, in the official template's order — mapped or not, filled or not. */
  shownFields: ClientImportFieldKey[];
}

export interface SmartJobForAnalysis {
  id: string;
  revision: number;
  mapping: unknown;
  headers: string[];
  blankHeaders: number;
  duplicateHeaders: number;
}

const cache = new Map<string, { at: number; value: SmartAnalysis }>();
const CACHE_MS = 30_000;

export function forgetSmartAnalysis(jobId: string): void {
  for (const key of cache.keys()) if (key.startsWith(`${jobId}:`)) cache.delete(key);
}

export async function analyzeSmartJob(job: SmartJobForAnalysis): Promise<SmartAnalysis> {
  const key = `${job.id}:${job.revision}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const mapping = upgradeMapping(job.mapping);
  const [staged, samples, lookups] = await Promise.all([
    prisma.clientImportRow.findMany({ where: { jobId: job.id }, orderBy: { rowNumber: "asc" }, select: { id: true, rowNumber: true, source: true, edits: true, ignored: true } }),
    projectSamples(),
    loadImportLookups(),
  ]);
  const value = await analyzeRows(
    staged.map((r) => ({ id: r.id, rowNumber: r.rowNumber, source: r.source as Record<string, string>, edits: r.edits as Partial<Record<ClientImportFieldKey, string>>, ignored: r.ignored })),
    mapping,
    samples,
    lookups,
    job,
  );
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 20) cache.delete(cache.keys().next().value!);
  return value;
}

type StagedForAnalysis = { id: string; rowNumber: number; source: Record<string, string>; edits: Partial<Record<ClientImportFieldKey, string>>; ignored: boolean };

async function analyzeRows(
  staged: StagedForAnalysis[],
  mapping: SmartMapping,
  samples: SmartSamples,
  lookups: Awaited<ReturnType<typeof loadImportLookups>>,
  job: Pick<SmartJobForAnalysis, "revision" | "headers" | "blankHeaders" | "duplicateHeaders">,
): Promise<SmartAnalysis> {
  const built = buildSmartRows(staged, mapping, samples);
  const resolved = { ...resolveRows(built.valid, lookups, { fillLocale: mapping.fillLocale !== false }), validBefore: new Map(built.valid.map((r) => [r.rowNumber, r])) };
  const repeats = findInFileDuplicates(resolved.valid);
  const { byKey, byCode } = await loadExistingMatches(
    resolved.valid.flatMap((r) => r.matchKeys),
    resolved.valid.flatMap((r) => (r.fields.code ? [r.fields.code] : [])),
  );
  const errorsByRow = new Map<number, string[]>([...built.invalid, ...resolved.invalid].map((i) => [i.rowNumber, i.errors]));
  const validByRow = new Map(resolved.valid.map((r) => [r.rowNumber, r]));
  const ignored = new Set(built.ignored);
  const blank = new Set(built.blank);

  const summary: SmartSummary = { total: staged.length, ready: 0, willCreate: 0, matchExisting: 0, repeats: 0, invalid: 0, ignored: 0, blank: 0, subscriptionRows: 0 };
  const rosterIssues = new Map(resolved.invalid.map((i) => [i.rowNumber, rosterFieldIssues(resolved.validBefore.get(i.rowNumber), lookups)]));
  const rows: RowAnalysis[] = staged.map((row) => {
    const output = built.outputs.get(row.rowNumber)!;
    const edited = SMART_FIELD_KEYS.filter((f) => Object.prototype.hasOwnProperty.call(row.edits ?? {}, f));
    const issues = [...(built.issues.get(row.rowNumber) ?? []), ...(rosterIssues.get(row.rowNumber) ?? [])];
    const expiryInfo = built.expiry.get(row.rowNumber);
    const base = {
      id: row.id,
      rowNumber: row.rowNumber,
      output,
      edited,
      errors: [] as string[],
      hasSubscription: false,
      issues,
      expiryBasis: expiryInfo?.basis ?? null,
      recordedExpiry: Boolean(validByRow.get(row.rowNumber)?.recordedExpiry),
      money: built.money.get(row.rowNumber) ?? null,
      derived: derivedValues(validByRow.get(row.rowNumber)),
      phoneNotes: validByRow.get(row.rowNumber)?.phoneNotes ?? [],
    };
    if (ignored.has(row.rowNumber)) {
      summary.ignored += 1;
      return { ...base, status: "IGNORED" };
    }
    if (blank.has(row.rowNumber)) {
      summary.blank += 1;
      return { ...base, status: "BLANK" };
    }
    const errors = errorsByRow.get(row.rowNumber);
    const valid = validByRow.get(row.rowNumber);
    if (errors || !valid) {
      summary.invalid += 1;
      return { ...base, status: "INVALID", errors: errors ?? ["The row could not be read."] };
    }
    const hasSubscription = Boolean(valid.resolved.subscription || valid.recordedExpiry);
    if (hasSubscription) summary.subscriptionRows += 1;
    const first = repeats.get(row.rowNumber);
    if (first !== undefined) {
      summary.repeats += 1;
      return { ...base, hasSubscription, status: "REPEAT", repeatsRow: first };
    }
    const matched = matchOf(valid, byKey, byCode);
    summary.ready += 1;
    if (matched) {
      summary.matchExisting += 1;
      return { ...base, hasSubscription, status: "MATCH", matchedClientId: matched };
    }
    summary.willCreate += 1;
    return { ...base, hasSubscription, status: "NEW" };
  });
  const recognisedColumns = Object.keys(autoMapSmart(job.headers).mapping.fields).length;
  const assessment = assessSmartFile({
    headers: job.headers,
    blankHeaders: job.blankHeaders,
    duplicateHeaders: job.duplicateHeaders,
    mapping,
    recognisedColumns,
    totalRows: summary.total - summary.ignored - summary.blank,
    readyRows: summary.ready,
    invalidRows: summary.invalid,
    moneyMultipleRows: rows.filter((r) => (r.status === "NEW" || r.status === "MATCH") && r.money?.status === "MULTIPLE").length,
    moneyProblemRows: rows.filter((r) => (r.status === "NEW" || r.status === "MATCH") && r.money?.status === "PROBLEM").length,
  });
  return { revision: job.revision, rows, summary, assessment, shownFields: [...SMART_REVIEW_ORDER] };
}

/** The values a row did not give but will receive, filled from its phone number or country ("Auto selected"). */
function derivedValues(row: ResolvedImportRow | undefined): RowAnalysis["derived"] {
  const out: RowAnalysis["derived"] = {};
  if (!row?.derived) return out;
  if (row.derived.country && row.resolved.country) out.country = row.resolved.country;
  if (row.derived.currency && row.resolved.preferredCurrency) out.currency = row.resolved.preferredCurrency;
  if (row.derived.language && row.fields.preferredLanguage) out.language = row.fields.preferredLanguage;
  return out;
}

/** A row's team / staff / seller / country / currency problems, each on its own field (the same resolver, one field at a time). */
function rosterFieldIssues(row: ImportedClientRow | undefined, lookups: Awaited<ReturnType<typeof loadImportLookups>>): FieldIssue[] {
  if (!row) return [];
  const empty = { country: null, currency: null, team: null, soldBy: null, assignedTo: null, subscription: null };
  const issues: FieldIssue[] = [];
  for (const field of ["country", "currency", "team", "assignedTo", "soldBy"] as const) {
    if (!row.extras[field]) continue;
    // Staff is checked against the team only when both are given, as the import itself does.
    const extras = field === "assignedTo" ? { ...empty, assignedTo: row.extras.assignedTo, team: row.extras.team } : { ...empty, [field]: row.extras[field] };
    const r = resolveImportExtras(extras, lookups);
    if (!r.ok) for (const message of r.errors) if (field !== "assignedTo" || !/^Team /.test(message)) issues.push({ field, severity: "error", message });
  }
  return issues;
}

export const ROW_FILTERS = ["all", "ready", "new", "match", "repeat", "invalid", "ignored", "edited"] as const;
export type RowFilter = (typeof ROW_FILTERS)[number];

export function filterRows(rows: readonly RowAnalysis[], filter: RowFilter, search: string): RowAnalysis[] {
  const needle = search.trim().toLowerCase();
  return rows.filter((r) => {
    const keep =
      filter === "all"
        ? r.status !== "BLANK"
        : filter === "ready"
          ? r.status === "NEW" || r.status === "MATCH"
          : filter === "new"
            ? r.status === "NEW"
            : filter === "match"
              ? r.status === "MATCH"
              : filter === "repeat"
                ? r.status === "REPEAT"
                : filter === "invalid"
                  ? r.status === "INVALID"
                  : filter === "ignored"
                    ? r.status === "IGNORED"
                    : r.edited.length > 0;
    if (!keep) return false;
    if (!needle) return true;
    return String(r.rowNumber) === needle || Object.values(r.output).some((v) => v.toLowerCase().includes(needle));
  });
}
