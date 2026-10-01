import { NextResponse, type NextRequest } from "next/server";
import * as XLSX from "xlsx";
import { requireAccess } from "@/server/authorize";
import { buildReport, reportDefinition } from "@/server/reports";
import { contentDisposition, reportFileName, tableHeader, tableRows, toCsv } from "@/server/reports/exportFile";

/**
 * Exports ONE table of a report exactly as it appears on the page: the browser sends the report's
 * filters (query string) and the keys of the rows to export in on-screen order — selected rows, the
 * current page, or everything the search left — and this rebuilds the report and writes those rows
 * from the very table the page rendered. POST because a thousand keys do not fit a URL. The Team
 * Report's own tables keep /api/team-report/table-export.
 */
const MAX_KEYS = 5000;

export async function POST(request: NextRequest, { params }: { params: Promise<{ report: string }> }) {
  const { report: id } = await params;
  const definition = reportDefinition(id);
  if (!definition) return new NextResponse("Unknown report.", { status: 404 });
  await requireAccess(definition.permission);

  let body: { table?: unknown; format?: unknown; keys?: unknown };
  try {
    body = await request.json();
  } catch {
    return new NextResponse("The export request was not readable.", { status: 400 });
  }
  const keys = Array.isArray(body.keys) ? body.keys.filter((k): k is string => typeof k === "string").slice(0, MAX_KEYS) : [];
  if (keys.length === 0) return new NextResponse("No rows were chosen to export.", { status: 400 });

  const query = Object.fromEntries(request.nextUrl.searchParams.entries());
  const { report, ctx } = await buildReport(id, query, new Date());
  const table = report.tables.find((t) => t.id === body.table);
  if (!table) return new NextResponse("Unknown table.", { status: 400 });

  const header = tableHeader(table);
  const rows = tableRows(table, keys);
  const name = reportFileName(report, ctx, table.title.replace(/\s*\(\d[\d,]*\)$/, ""));
  if (body.format === "csv") {
    return new NextResponse(toCsv(header, rows), {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": contentDisposition(`${name}.csv`) },
    });
  }
  const sheet = XLSX.utils.aoa_to_sheet([header, ...rows]);
  sheet["!cols"] = header.map((label, i) => ({ wch: Math.min(60, Math.max(label.length, ...rows.slice(0, 500).map((r) => String(r[i] ?? "").length)) + 2) }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, table.sheet);
  return new NextResponse(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": contentDisposition(`${name}.xlsx`),
    },
  });
}
