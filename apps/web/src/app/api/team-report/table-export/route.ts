import { NextResponse, type NextRequest } from "next/server";
import * as XLSX from "xlsx";
import { sanitizeExcelCell } from "@support-automation/shared";
import { requireAccess } from "@/server/authorize";
import { loadTeamReport, memberLabel, parseTeamReportFilters } from "@/server/teamReport";
import { buildReportTable, type TeamReportTableId } from "@/server/teamReportTables";

/**
 * Exports ONE Team Report table — Team members or By day — exactly as it appears on the page.
 *
 * The browser sends the report's filters (query string) and the keys of the rows to export, in the
 * order it shows them: the selected rows, the current page, or everything the search left. This
 * recomputes the same report and builds rows with the very function the page rendered from
 * (`buildReportTable`), so column order, names and values match the table; the checkbox column is
 * UI only and never written. POST because a selection of a thousand keys does not fit a URL.
 *
 * The full multi-sheet report export stays at /api/team-report/export.
 */

const TABLES: Record<TeamReportTableId, string> = { members: "Team members", days: "By day" };
const MAX_KEYS = 5000;

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function toCsv(header: string[], rows: Array<Array<string | number>>): string {
  const escapeCell = (value: string | number) => {
    const str = String(value);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  // A BOM so Excel opens the CSV as UTF-8 — the "–" in date ranges and Bangla names survive.
  return "﻿" + [header, ...rows].map((row) => row.map(escapeCell).join(",")).join("\r\n");
}

export async function POST(request: NextRequest) {
  await requireAccess("support_activity.view");
  let body: { table?: unknown; format?: unknown; keys?: unknown };
  try {
    body = await request.json();
  } catch {
    return new NextResponse("The export request was not readable.", { status: 400 });
  }
  const tableId = body.table === "members" || body.table === "days" ? body.table : null;
  if (!tableId) return new NextResponse("Unknown table.", { status: 400 });
  const format = body.format === "csv" ? "csv" : "xlsx";
  const keys = Array.isArray(body.keys) ? body.keys.filter((k): k is string => typeof k === "string").slice(0, MAX_KEYS) : [];
  if (keys.length === 0) return new NextResponse("No rows were chosen to export.", { status: 400 });

  const now = new Date();
  const params = Object.fromEntries(request.nextUrl.searchParams.entries());
  const data = await loadTeamReport(parseTeamReportFilters(params, now), now);
  const table = buildReportTable(tableId, data);

  // In the order the page showed them; a key the recomputed report no longer has is skipped.
  const byKey = new Map(table.rows.map((row) => [row.key, row]));
  // Every text cell is made formula-safe (a name starting with "=" must not run in somebody's
  // spreadsheet) — CSV too, since Excel opens CSV the same way.
  const rows = keys
    .map((key) => byKey.get(key))
    .filter((row) => row !== undefined)
    .map((row) => row.cells.map((cell) => (typeof cell === "string" ? sanitizeExcelCell(cell) : cell)));
  const header = table.columns.map((c) => c.label);

  const memberName = data.filters.memberId ? memberLabel(data.filters.memberId, data.memberNames) : null;
  const safe = (text: string) => text.replace(/[^\p{L}\p{N} .–_-]+/gu, " ").replace(/\s+/g, " ").trim();
  const name = ["Team Report", TABLES[tableId], data.teamName, memberName, data.range.label]
    .filter(Boolean)
    .map((part) => safe(part!))
    .join(" - ");

  if (format === "csv") {
    return new NextResponse(toCsv(header, rows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": contentDisposition(`${name}.csv`),
      },
    });
  }

  // Array-of-arrays keeps the column order exactly as the table's.
  const sanitized = rows;
  const sheet = XLSX.utils.aoa_to_sheet([header, ...sanitized]);
  sheet["!cols"] = header.map((label, i) => ({
    wch: Math.min(48, Math.max(label.length, ...sanitized.map((r) => String(r[i] ?? "").length)) + 2),
  }));
  sheet["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: sanitized.length, c: header.length - 1 } }) };
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, TABLES[tableId]);
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return new NextResponse(buffer as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": contentDisposition(`${name}.xlsx`),
    },
  });
}
