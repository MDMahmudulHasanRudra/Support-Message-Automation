import * as XLSX from "xlsx";
import { sanitizeExcelCell } from "@support-automation/shared";
import type { ReportContext } from "./context";
import type { BuiltReport, ReportTable } from "./types";

/**
 * Turns a built report into files. The page and the export get the SAME BuiltReport from the same
 * builder and the same URL filters, so the file has the table's columns, names, order and values.
 * Every text cell is made formula-safe (a group named "=HYPERLINK(...)" must not run in somebody's
 * spreadsheet) — CSV too, since Excel opens CSV the same way.
 */

export type Cell = string | number;

export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** A BOM so Excel opens it as UTF-8 — Bangla names and the "–" in ranges survive. */
export function toCsv(header: string[], rows: Cell[][]): string {
  const escapeCell = (value: Cell) => {
    const str = String(value);
    return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  return "﻿" + [header, ...rows].map((row) => row.map(escapeCell).join(",")).join("\r\n");
}

const safeCells = (cells: Cell[]) => cells.map((cell) => (typeof cell === "string" ? sanitizeExcelCell(cell) : cell));

export const tableHeader = (table: ReportTable) => table.columns.map((c) => c.label);
export const tableRows = (table: ReportTable, keys?: readonly string[]): Cell[][] => {
  if (!keys) return table.rows.map((row) => safeCells(row.cells));
  const byKey = new Map(table.rows.map((row) => [row.key, row]));
  return keys.map((key) => byKey.get(key)).filter((row) => row !== undefined).map((row) => safeCells(row.cells));
};

/** "Inactive Groups - Support Team - September 2026": a file says what it is once it has left the page. */
export function reportFileName(report: BuiltReport, ctx: ReportContext, part?: string): string {
  const safe = (text: string) => text.replace(/[^\p{L}\p{N} .–_-]+/gu, " ").replace(/\s+/g, " ").trim();
  const memberName = ctx.filters.memberId ? ctx.memberName(ctx.filters.memberId) : null;
  return [report.title, part, ctx.data.teamName, memberName, ctx.data.range.label]
    .filter((p): p is string => Boolean(p))
    .map(safe)
    .join(" - ");
}

const iso = (ms: number) =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Dhaka",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ms));

function addSheet(workbook: XLSX.WorkBook, name: string, header: string[], rows: Cell[][]) {
  const sheet = XLSX.utils.aoa_to_sheet([header, ...rows]);
  sheet["!cols"] = header.map((label, i) => ({
    wch: Math.min(60, Math.max(label.length, ...rows.slice(0, 500).map((r) => String(r[i] ?? "").length)) + 2),
  }));
  if (rows.length) sheet["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: header.length - 1 } }) };
  XLSX.utils.book_append_sheet(workbook, sheet, name);
}

/** Excel sheet names: 31 characters, none of []:*?/\, unique within the workbook. */
function sheetName(wanted: string, taken: Set<string>): string {
  const base = wanted.replace(/[[\]:*?/\\]/g, " ").slice(0, 31).trim() || "Sheet";
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base.slice(0, 28)} ${i}`;
  taken.add(name);
  return name;
}

/** Summary (filters, figures, formulas), Detailed (the main table), Breakdown (each other table). */
export function reportWorkbook(report: BuiltReport, ctx: ReportContext): Buffer {
  const { filters, range } = ctx.data;
  const summary: Cell[][] = [
    ["Report", report.title],
    ["Question", report.question],
    ["Showing", ctx.scopeText],
    ["Period", range.label],
    ["Period start (Asia/Dhaka)", iso(range.start.getTime())],
    ["Period end (Asia/Dhaka, exclusive)", iso(range.end.getTime())],
    ["Groups", filters.groupKeys?.length ? filters.groupKeys.map(ctx.groupName).join(", ") : "All groups"],
    ["WhatsApp account", filters.accountId ? (ctx.options.accounts.find((a) => a.id === filters.accountId)?.label ?? filters.accountId) : "All accounts"],
    ...(report.usesGranularity ? [["Breakdown", filters.granularity] as Cell[]] : []),
    ...report.selects.map((s) => [s.label, s.options.find((o) => o.value === s.value)?.label ?? s.value] as Cell[]),
    // How far the figures can be trusted — the same reading the page shows above them.
    ["Data health", ctx.dataHealth.label],
    ["Data health detail", ctx.dataHealth.headline],
    ["Verified from (Asia/Dhaka)", ctx.dataHealth.verifiedFrom ? iso(ctx.dataHealth.verifiedFrom) : "Not set"],
    ...ctx.dataHealth.warnings.map((w) => ["Data caveat", w] as Cell[]),
    ["", ""],
    ...report.tiles.map((t) => [t.label, t.hint ? `${t.value} (${t.hint})` : t.value] as Cell[]),
    ["", ""],
    ...report.notes.map((n) => ["Note", n.text] as Cell[]),
    ...report.formulas.map((f) => [`Formula: ${f.title}`, f.text] as Cell[]),
  ].map(safeCells);

  const workbook = XLSX.utils.book_new();
  const taken = new Set<string>();
  addSheet(workbook, sheetName("Summary", taken), ["Item", "Value"], summary);
  const detailed = report.tables.filter((t) => t.sheet === "Detailed");
  const breakdown = report.tables.filter((t) => t.sheet === "Breakdown");
  for (const table of detailed) addSheet(workbook, sheetName(detailed.length > 1 ? `Detailed - ${table.title}` : "Detailed", taken), tableHeader(table), tableRows(table));
  for (const table of breakdown) {
    addSheet(workbook, sheetName(breakdown.length > 1 ? `Breakdown - ${table.title}` : "Breakdown", taken), tableHeader(table), tableRows(table));
  }
  if (report.tables.length === 0) addSheet(workbook, sheetName("Detailed", taken), ["Note"], [["Nothing to export for these filters."]]);
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
