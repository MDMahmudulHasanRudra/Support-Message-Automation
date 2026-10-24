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
  SMART_SAMPLE_VALUES,
  upgradeMapping,
  type ClientImportFieldKey,
  type FileAssessment,
  type SheetRecords,
  type SmartMapping,
  type SmartSamples,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { activeDisabledFeatures } from "@/server/projectFeatures";
import { loadExistingMatches } from "@/server/clientRecords";
import { loadImportLookups, resolveRows } from "@/server/clientImportExtras";
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
      const wanted = choice.sheet && names.includes(choice.sheet) ? choice.sheet : undefined;
      workbook = XLSX.read(buffer, { type: "buffer", sheetRows, dense: true, sheets: wanted ?? names[0], ...READ_OPTIONS });
      workbook.SheetNames = names;
    }
  } catch {
    return { error: "That file could not be read. It may be damaged; open it in Excel, save it as .xlsx or .csv, and try again." };
  }
  const sheetNames = workbook.SheetNames.slice(0, 50);
  const sheetName = choice.sheet && sheetNames.includes(choice.sheet) ? choice.sheet : sheetNames[0];
  const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;
  if (!sheetName || !sheet) return { error: "The file has no sheet to read." };
  const grid = sheetGrid(sheet);
  if (!grid.some((row) => row.some(Boolean))) return { error: `The sheet "${sheetName}" is empty.${sheetNames.length > 1 ? " Choose another sheet." : ""}` };
  const headerIndex =
    choice.headerRow && choice.headerRow >= 1 && choice.headerRow <= SMART_IMPORT_LIMITS.maxHeaderRow ? choice.headerRow - 1 : detectHeaderRow(grid);
  const records = gridToRecords(grid, headerIndex);
  if ("error" in records) return records;
  return { sheetNames, sheetName, headerRow: headerIndex + 1, records, topRows: grid.slice(0, 8).map((r) => r.slice(0, 12).map((c) => c.slice(0, 60))) };
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
  /** Fields worth showing as columns on the review: mapped, or corrected on some row. */
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
  const resolved = resolveRows(built.valid, lookups);
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
  const shown = new Set<ClientImportFieldKey>(["name"]);
  for (const field of SMART_FIELD_KEYS) if (mapping.fields[field]) shown.add(field);
  const rows: RowAnalysis[] = staged.map((row) => {
    const output = built.outputs.get(row.rowNumber)!;
    const edited = SMART_FIELD_KEYS.filter((f) => Object.prototype.hasOwnProperty.call(row.edits ?? {}, f));
    for (const f of edited) shown.add(f);
    const base = { id: row.id, rowNumber: row.rowNumber, output, edited, errors: [] as string[], hasSubscription: false };
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
    const hasSubscription = Boolean(valid.resolved.subscription);
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
  });
  return { revision: job.revision, rows, summary, assessment, shownFields: SMART_FIELD_KEYS.filter((f) => shown.has(f)) };
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
