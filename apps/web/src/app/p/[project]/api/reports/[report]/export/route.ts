import { NextResponse, type NextRequest } from "next/server";
import { requireAccess } from "@/server/authorize";
import { buildReport, reportDefinition } from "@/server/reports";
import { contentDisposition, reportFileName, reportWorkbook, tableHeader, tableRows, toCsv } from "@/server/reports/exportFile";

/**
 * A report's file export. CSV is the report's main (Detailed) table; Excel is the whole report —
 * Summary (filters, figures, formulas), Detailed and Breakdown sheets. It builds the report with the
 * very builder and URL filters the page used, so the file cannot disagree with the screen. A Route
 * Handler because a download cannot come from a Server Action, as with the Team Report export.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ report: string }> }) {
  const { report: id } = await params;
  const definition = reportDefinition(id);
  if (!definition) return new NextResponse("Unknown report.", { status: 404 });
  await requireAccess(definition.permission);

  const query = Object.fromEntries(request.nextUrl.searchParams.entries());
  const { report, ctx } = await buildReport(id, query, new Date());
  const name = reportFileName(report, ctx);

  if (query.format !== "xlsx") {
    const main = report.tables.find((t) => t.sheet === "Detailed") ?? report.tables[0];
    const body = main ? toCsv(tableHeader(main), tableRows(main)) : toCsv(["Note"], [["Nothing to export for these filters."]]);
    return new NextResponse(body, {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": contentDisposition(`${name}.csv`) },
    });
  }
  return new NextResponse(reportWorkbook(report, ctx) as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": contentDisposition(`${name}.xlsx`),
    },
  });
}
