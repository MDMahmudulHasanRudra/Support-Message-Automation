import { NextResponse, type NextRequest } from "next/server";
import * as XLSX from "xlsx";
import {
  formatMinuteOfDay,
  getDhakaDayRange,
  sanitizeExcelRow,
} from "@support-automation/shared";
import { requireSession } from "@/server/auth";
import { hasPermission } from "@/server/permissions";
import { DUTY_STATE_LABEL } from "@/lib/dutyState";
import {
  formatShiftRange,
  getDutyHistory,
  groupDutyHistoryByMember,
} from "@/server/teamManagementReports";

/**
 * Duty history as a file, for the timesheet and payroll conversations this page gets opened for.
 *
 * A Route Handler rather than a Server Action, for the reason the Support Activity and Teams
 * exports already are: a file download cannot be triggered from a Server Action. Read-only, and it
 * calls the SAME `getDutyHistory` the page itself renders, so an exported figure can never differ
 * from the one on screen — which is the whole risk with an export built on its own queries.
 *
 * Permission is checked explicitly. `requireSession` only establishes who is asking, and duty
 * history is a record about named people; the page it mirrors gates on `team_management.view`, so
 * this does too rather than being reachable by any signed-in user with the URL.
 *
 * Every row goes through `sanitizeExcelRow`. Group names, member names and a manager's free-text
 * correction reason are all typed by a person, and a cell beginning `=` is executed as a formula by
 * Excel when the file is reopened. The Support Activity export predates that helper and does not do
 * this; new exports should.
 */

function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]!);
  const escapeCell = (value: unknown) => {
    const str = value === null || value === undefined ? "" : String(value);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  return [headers.join(","), ...rows.map((row) => headers.map((h) => escapeCell(row[h])).join(","))].join("\n");
}

function fileResponse(body: string | Buffer, filename: string, contentType: string) {
  return new NextResponse(body as unknown as BodyInit, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

export async function GET(request: NextRequest) {
  const session = await requireSession();
  if (!(await hasPermission(session, "team_management.view"))) {
    return NextResponse.json({ error: "You do not have permission to export duty history." }, { status: 403 });
  }

  const params = request.nextUrl.searchParams;
  const format = params.get("format") === "xlsx" ? "xlsx" : "csv";
  const byMember = params.get("view") === "member";
  const teamMemberId = params.get("member") ?? undefined;

  const fromParam = params.get("from");
  const toParam = params.get("to");
  const parsedFrom = fromParam ? new Date(fromParam) : null;
  const parsedTo = toParam ? new Date(toParam) : null;
  const range =
    parsedFrom && parsedTo && !Number.isNaN(parsedFrom.getTime()) && !Number.isNaN(parsedTo.getTime())
      ? { start: parsedFrom, end: parsedTo }
      : getDhakaDayRange(new Date());

  // One large page rather than the screen's 500: a download exists precisely to carry the whole
  // range, so paging it would produce a file that silently ends where the table happened to.
  const EXPORT_PAGE_SIZE = 50_000;
  const { rows: history } = await getDutyHistory(range, teamMemberId || undefined, 1, EXPORT_PAGE_SIZE);

  const rows: Array<Record<string, unknown>> = byMember
    ? groupDutyHistoryByMember(history).map((row) =>
        sanitizeExcelRow({
          "Team member": row.memberName,
          "Days scheduled": row.daysScheduled,
          "Days with activity": row.daysWorked,
          "No activity recorded": row.noActivityDays,
          "Off-day duty": row.offDayDuties,
          "Late starts": row.lateStarts,
          "Early finishes": row.earlyFinishes,
          "Median engaged (minutes)": row.medianEngagedMinutes ?? "",
          Messages: row.totalMessages,
        }),
      )
    : history.map((row) =>
        sanitizeExcelRow({
          Date: row.dutyDate.toISOString().slice(0, 10),
          "Team member": row.memberName,
          Shift: row.shiftName ?? "",
          "Shift hours": formatShiftRange(row.shiftStartMinute, row.shiftEndMinute) ?? "",
          "First message": row.punctuality.startedMinute === null ? "" : formatMinuteOfDay(row.punctuality.startedMinute),
          "Last message": row.punctuality.endedMinute === null ? "" : formatMinuteOfDay(row.punctuality.endedMinute),
          "Engaged (minutes)": row.punctuality.engagedMinutes ?? "",
          "Late by (minutes)": row.punctuality.lateByMinutes ?? "",
          "Left early by (minutes)": row.punctuality.leftEarlyByMinutes ?? "",
          "Late start": row.punctuality.isLate ? "Yes" : "",
          "Early finish": row.punctuality.isEarlyFinish ? "Yes" : "",
          Messages: row.messageCount,
          Groups: row.uniqueGroupCount,
          // The derived reading, spelled the way the badge spells it. An export that said
          // "NO_ACTIVITY" where the screen says "No activity recorded" invites the exact reading
          // this module refuses — that it is a claim somebody was absent.
          Reading: DUTY_STATE_LABEL[row.derived],
          Correction: row.override ?? "",
          "Corrected by": row.overriddenByName ?? "",
          "Corrected at": row.overriddenAt?.toISOString() ?? "",
          "Correction reason": row.overrideReason ?? "",
        }),
      );

  const baseName = `duty-history-${byMember ? "by-person-" : ""}${new Date().toISOString().slice(0, 10)}`;

  if (format === "csv") {
    return fileResponse(toCsv(rows), `${baseName}.csv`, "text/csv; charset=utf-8");
  }

  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, byMember ? "By person" : "Duty history");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return fileResponse(buffer, `${baseName}.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
}
