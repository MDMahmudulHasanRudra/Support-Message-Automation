import { NextResponse, type NextRequest } from "next/server";
import * as XLSX from "xlsx";
import { excelDhakaSerial, formatResponseDuration, formatSlaCompliance, sanitizeExcelCell, SUPPORT_ASSIGNMENT_STATUS_LABELS } from "@support-automation/shared";
import { requireAccess } from "@/server/authorize";
import { loadSupportAssignmentReport, parseReportFilters } from "@/server/supportAssignmentReport";

/**
 * Excel / CSV export of the Support Assignment Report (SUPPORT_ASSIGNMENT.md). Built from the same
 * loader and the same pure computation as the page, through the project-scoped client, so the file
 * holds exactly what the page shows for the same filters.
 *
 * Excel: Summary, Employees, Groups and Cases sheets. CSV: the Cases list (one table per file).
 * Dates are real Excel date-times on the Dhaka clock; durations as text and as seconds.
 */

type Cell = string | number | null;
const date = (d: Date | null): Cell => (d ? excelDhakaSerial(d) : null);
const text = (s: string | null | undefined): Cell => (s ? sanitizeExcelCell(s) : null);

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function sheet(header: string[], rows: Cell[][], dateColumns: number[] = []): XLSX.WorkSheet {
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  for (const c of dateColumns) {
    for (let r = 1; r <= rows.length; r++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (cell && typeof cell.v === "number") cell.z = "yyyy-mm-dd hh:mm";
    }
  }
  ws["!cols"] = header.map((h) => ({ wch: Math.min(48, Math.max(12, h.length + 2)) }));
  return ws;
}

export async function GET(request: NextRequest) {
  await requireAccess("support_assignment.view");
  const params = Object.fromEntries(request.nextUrl.searchParams.entries());
  const format = params.format === "csv" ? "csv" : "xlsx";
  const filters = parseReportFilters(params, new Date());
  const { report, cases, memberNames, truncated } = await loadSupportAssignmentReport(filters);
  const name = (id: string) => memberNames.get(id) ?? "(removed member)";
  const dur = (s: number | null) => (s === null ? null : formatResponseDuration(s));

  const caseHeader = ["Status", "Group", "Account", "Customer", "Message", "Opened", "Assigned to", "Assigned", "Due", "Completed", "Answered by", "Response", "Response (seconds)", "SLA", "Case ID"];
  const caseRows: Cell[][] = cases.map((c) => [
    SUPPORT_ASSIGNMENT_STATUS_LABELS[c.status],
    text(c.groupName),
    text(c.accountLabel),
    text(c.customer),
    text(c.message),
    date(c.openedAt),
    text(c.assignedTo),
    date(c.assignedAt),
    date(c.dueAt),
    date(c.completedAt),
    text(c.answeredBy),
    dur(c.responseSeconds),
    c.responseSeconds,
    c.sla === "MET" ? "Met" : c.sla === "MISSED" ? "Missed" : null,
    c.id,
  ]);
  const stamp = new Date(Date.now() + 6 * 3_600_000).toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const filename = `support-assignment-${filters.from}_${filters.to}-${stamp}`;

  if (format === "csv") {
    const esc = (v: Cell, i: number) => {
      if (v === null) return "";
      if ([5, 7, 8, 9].includes(i) && typeof v === "number") {
        return new Date((v - 25_569) * 86_400_000 - 6 * 3_600_000).toLocaleString("en-GB", { timeZone: "Asia/Dhaka" });
      }
      const s = String(v);
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = "﻿" + [caseHeader.join(","), ...caseRows.map((r) => r.map(esc).join(","))].join("\r\n");
    return new NextResponse(csv, {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": contentDisposition(`${filename}.csv`) },
    });
  }

  const s = report.summary;
  const summary: Cell[][] = [
    ["Period (Dhaka)", filters.rangeLabel],
    ["Employee filter", filters.memberId ? name(filters.memberId) : "Everyone"],
    ["Group filter", filters.group || "All"],
    ["Status filter", filters.status ? SUPPORT_ASSIGNMENT_STATUS_LABELS[filters.status] : "Any"],
    ["SLA filter", filters.sla || "Any"],
    ["Support cases", s.total],
    ["Unassigned", s.unassigned],
    ["Assigned", s.assigned],
    ["Completed", s.completed],
    ["Answered by someone else", s.answeredByOther],
    ["Pending", s.pending],
    ["Overdue", s.overdue],
    ["Cancelled", s.cancelled],
    ["Ignored / filtered", s.ignored],
    ["Average response", dur(s.avgResponseSeconds)],
    ["SLA compliance", formatSlaCompliance(s.sla)],
    ["SLA met / measured", `${s.sla.met} / ${s.sla.measured}`],
    ...(truncated ? [["Note", "More than 20,000 cases opened in this period; only the first 20,000 are counted."] as Cell[]] : []),
  ];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet(["Figure", "Value"], summary), "Summary");
  XLSX.utils.book_append_sheet(
    book,
    sheet(
      ["Employee", "Assigned", "Completed", "Pending", "Overdue", "Answered by others", "Reassigned away", "Avg response", "Avg response (seconds)", "SLA compliance"],
      report.employees.map((e) => [
        text(name(e.memberId)),
        e.assigned,
        e.completed,
        e.pending,
        e.overdue,
        e.answeredByOther,
        e.reassignedAway,
        dur(e.avgResponseSeconds),
        e.avgResponseSeconds,
        formatSlaCompliance(e.sla),
      ]),
    ),
    "Employees",
  );
  XLSX.utils.book_append_sheet(
    book,
    sheet(
      ["Group", "Cases", "Completed", "Answered by others", "Still open", "Overdue", "Avg response", "Avg response (seconds)"],
      report.groups.map((g) => [text(g.groupName), g.cases, g.completed, g.answeredByOther, g.open, g.overdue, dur(g.avgResponseSeconds), g.avgResponseSeconds]),
    ),
    "Groups",
  );
  XLSX.utils.book_append_sheet(book, sheet(caseHeader, caseRows, [5, 7, 8, 9]), "Cases");
  const buffer = XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": contentDisposition(`${filename}.xlsx`),
    },
  });
}
