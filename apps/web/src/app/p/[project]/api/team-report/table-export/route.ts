import { NextResponse, type NextRequest } from "next/server";
import * as XLSX from "xlsx";
import { sanitizeExcelCell } from "@support-automation/shared";
import { requireAccess } from "@/server/authorize";
import { exportStoredBy, loadTeamReport, memberLabel, parseTeamReportFilters, reportNow } from "@/server/teamReport";
import { buildPersonalReportTable, buildReportTable, isPersonalTableId, type PersonalTableId, type ReportTableData, type TeamReportTableId } from "@/server/teamReportTables";
import { loadPersonalReport } from "@/server/personalReport";
import { resolvePageScope, withReportScope } from "@/server/unifiedReporting";

/**
 * Exports ONE Team Report table — Team members, By day or Groups — exactly as it appears on the page.
 *
 * The browser sends the report's filters (query string) and the keys of the rows to export, in the
 * order it shows them: the selected rows, the current page, or everything the search left. This
 * recomputes the same report and builds rows with the very function the page rendered from
 * (`buildReportTable`), so column order, names and values match the table; the checkbox column is
 * UI only and never written. POST because a selection of a thousand keys does not fit a URL.
 *
 * The full multi-sheet report export stays at /api/team-report/export.
 */

const TABLES: Record<TeamReportTableId, string> = { members: "Team members", days: "By day", groups: "Groups" };
const PERSONAL_TABLES: Record<PersonalTableId, string> = { "personal-conversations": "Personal conversations", "personal-days": "Personal by day", "personal-members": "Personal members" };
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
  const session = await requireAccess("support_activity.view");
  let body: { table?: unknown; format?: unknown; keys?: unknown };
  try {
    body = await request.json();
  } catch {
    return new NextResponse("The export request was not readable.", { status: 400 });
  }
  const personalId = isPersonalTableId(body.table) ? body.table : null;
  const tableId =
    typeof body.table === "string" && Object.prototype.hasOwnProperty.call(TABLES, body.table) ? (body.table as TeamReportTableId) : null;
  if (!tableId && !personalId) return new NextResponse("Unknown table.", { status: 400 });
  const format = body.format === "csv" ? "csv" : "xlsx";
  if (Array.isArray(body.keys) && body.keys.length > MAX_KEYS) {
    // Refused out loud rather than cut short: a file that silently stops at row 5,000 reads as complete.
    return new NextResponse(
      `That is ${body.keys.length.toLocaleString("en-US")} rows; a table export takes at most ${MAX_KEYS.toLocaleString("en-US")}. Use the report's CSV or Excel button for everything, or narrow the filters.`,
      { status: 413 },
    );
  }
  const keys = Array.isArray(body.keys) ? body.keys.filter((k): k is string => typeof k === "string").slice(0, MAX_KEYS) : [];
  if (keys.length === 0) return new NextResponse("No rows were chosen to export.", { status: 400 });

  const params = Object.fromEntries(request.nextUrl.searchParams.entries());
  const now = reportNow(params);
  // A personal table is personal content: the feature must be on and the viewer needs `messages.view`, the
  // same gate as the page. It is refused out loud, never answered with a group table instead.
  const { scope: resolvedScope } = await resolvePageScope(params, session);
  if (personalId && resolvedScope === "group") {
    return new NextResponse("Personal chat reporting needs the View Messages permission.", { status: 403 });
  }
  const filters = withReportScope(parseTeamReportFilters(params, now), resolvedScope);
  let table: ReportTableData;
  let data: { filters: typeof filters; teamName: string | null; memberNames: Map<string, string>; range: { label: string } };
  if (personalId) {
    const personal = await loadPersonalReport(filters, now, exportStoredBy(params, now));
    table = buildPersonalReportTable(personalId, personal, { linkToChat: false });
    data = personal;
  } else {
    const group = await loadTeamReport(filters, now, undefined, exportStoredBy(params, now));
    table = buildReportTable(tableId!, group);
    data = group;
  }

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
  // The day/week/month table is named after its breakdown, not always "By day".
  const tableName = personalId ? PERSONAL_TABLES[personalId] : tableId === "days" ? `By ${data.filters.granularity}` : TABLES[tableId!];
  const name = ["Team Report", tableName, data.teamName, memberName, data.range.label]
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
  XLSX.utils.book_append_sheet(workbook, sheet, tableName);
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return new NextResponse(buffer as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": contentDisposition(`${name}.xlsx`),
    },
  });
}
