import { NextResponse, type NextRequest } from "next/server";
import * as XLSX from "xlsx";
import { sanitizeExcelRow } from "@support-automation/shared";
import { requireAccess } from "@/server/authorize";
import { loadSheetReport, parseSheetReportFilters, PERIOD_LABELS, type SheetReportFilters } from "@/server/google/reports";
import { employeeDaysTable, employeeSheetsTable, employeesTable, sheetMembersTable, sheetsTable, type ReportTable } from "@/server/google/reportTables";

/**
 * Spreadsheet work reports export (Phases 9–10). A Route Handler because a file download cannot come
 * from a Server Action. It runs the same `loadSheetReport` and builds the same tables the page shows
 * (`reportTables.ts`), so the file and the screen cannot disagree. Durations are decimal hours here.
 * Every text cell goes through `sanitizeExcelRow`: sheet and person names are typed by people, and a
 * name starting with "=" must not become a formula in somebody's spreadsheet.
 */
export const dynamic = "force-dynamic";

const hours = (ms: number) => Math.round((ms / 3_600_000) * 100) / 100;

function toRecords(table: ReportTable): Array<Record<string, string | number>> {
  return table.rows.map((row) => {
    const out: Record<string, string | number> = {};
    for (const c of table.columns) {
      const value = row.cells[c.key] ?? "";
      out[c.kind === "duration" ? `${c.label} (hours)` : c.label] = c.kind === "duration" ? hours(Number(value)) : value;
    }
    return sanitizeExcelRow(out);
  });
}

function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]!);
  const cell = (value: unknown) => {
    const str = value === null || value === undefined ? "" : String(value);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  return [headers.join(","), ...rows.map((row) => headers.map((h) => cell(row[h])).join(","))].join("\n");
}

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function GET(request: NextRequest) {
  await requireAccess("google_sheets.report", "GOOGLE_SHEETS");
  const params = Object.fromEntries(request.nextUrl.searchParams.entries());
  const view = params.view === "sheets" ? "sheets" : "employees";
  const format = params.format === "csv" ? "csv" : "xlsx";
  const filters = parseSheetReportFilters(params);
  const scoped: SheetReportFilters = view === "employees" ? { ...filters, spreadsheetId: null } : { ...filters, userId: null };
  const data = await loadSheetReport(scoped);

  const main =
    view === "employees"
      ? employeesTable(data)
      : filters.spreadsheetId
        ? sheetMembersTable(data, filters.spreadsheetId)
        : sheetsTable(data);
  const subject =
    view === "employees" && filters.userId
      ? data.people.get(filters.userId)?.name ?? "employee"
      : view === "sheets" && filters.spreadsheetId
        ? data.sheetInfo.get(filters.spreadsheetId)?.name ?? "spreadsheet"
        : view === "employees"
          ? "employees"
          : "spreadsheets";
  const base = `Spreadsheet work - ${subject} - ${data.range.label}`.replace(/[\\/:*?"<>|]/g, "-");

  if (format === "csv") {
    return new NextResponse(`﻿${toCsv(toRecords(main))}`, {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": contentDisposition(`${base}.csv`), "Cache-Control": "no-store" },
    });
  }

  const book = XLSX.utils.book_new();
  const summary = [
    { Item: "Report", Value: view === "employees" ? "By employee" : "By spreadsheet" },
    { Item: "Period", Value: `${PERIOD_LABELS[filters.period]} — ${data.range.label} (Dhaka days)` },
    { Item: "Subject", Value: subject },
    { Item: "Monitored spreadsheets only", Value: filters.monitoredOnly ? "Yes" : "No" },
    { Item: "A pause starts after (minutes)", Value: data.inactivityMinutes },
    { Item: "Work time", Value: "Built from interaction in the app while able to change the sheet; gaps longer than the pause threshold are not counted." },
    { Item: "Edits in Google", Value: "Counts read from Google's record for monitored spreadsheets — never time. Credited only through a person's own linked Google account." },
    { Item: "Generated", Value: new Date().toISOString() },
  ].map((r) => sanitizeExcelRow(r));
  XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(summary), "Summary");
  XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(toRecords(main)), view === "employees" ? "Employees" : filters.spreadsheetId ? "Members" : "Spreadsheets");
  if (view === "employees" && filters.userId) {
    XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(toRecords(employeeDaysTable(data, filters.userId))), "By day");
    XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(toRecords(employeeSheetsTable(data, filters.userId))), "By spreadsheet");
  }
  if (view === "sheets" && !filters.spreadsheetId) {
    // Every spreadsheet's member breakdown, one block per sheet.
    const rows = data.sheets.flatMap((s) => toRecords(sheetMembersTable(data, s.spreadsheetId)).map((r) => ({ Spreadsheet: data.sheetInfo.get(s.spreadsheetId)?.name ?? "", ...r })));
    XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows.map((r) => sanitizeExcelRow(r))), "Members");
  }
  const buffer = XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": contentDisposition(`${base}.xlsx`),
      "Cache-Control": "no-store",
    },
  });
}
