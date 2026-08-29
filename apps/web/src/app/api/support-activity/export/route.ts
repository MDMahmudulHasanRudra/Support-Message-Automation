import { NextResponse, type NextRequest } from "next/server";
import * as XLSX from "xlsx";
import { requireSession } from "@/server/auth";
import { getDhakaDayRange } from "@/lib/supportActivityPeriod";
import { getActivitiesForExport, getPerTeamMemberBreakdown, getSessionsForExport } from "@/server/supportActivityReports";

/**
 * Export endpoint for Support Activity Tracking's Activity/Team/Reports pages. This is the app's
 * second-ever Route Handler (after /api/health) — everything else in this app is Server
 * Components + Server Actions, but a file download can't be triggered from a Server Action, so a
 * plain GET endpoint returning a Content-Disposition response is the justified exception here.
 * Read-only: fetches via the same supportActivityReports.ts functions the dashboard pages
 * themselves use, so an export can never show different numbers than what's on screen.
 */

function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]!);
  const escapeCell = (value: unknown) => {
    const str = value === null || value === undefined ? "" : String(value);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const lines = [headers.join(","), ...rows.map((row) => headers.map((h) => escapeCell(row[h])).join(","))];
  return lines.join("\n");
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
  await requireSession();

  const params = request.nextUrl.searchParams;
  const rawType = params.get("type");
  const type = rawType === "team" ? "team" : rawType === "sessions" ? "sessions" : "activities";
  const format = params.get("format") === "xlsx" ? "xlsx" : "csv";
  const groupId = params.get("groupId") ?? undefined;
  const fromParam = params.get("from");
  const toParam = params.get("to");

  const parsedFrom = fromParam ? new Date(fromParam) : null;
  const parsedTo = toParam ? new Date(toParam) : null;
  const range =
    parsedFrom && parsedTo && !Number.isNaN(parsedFrom.getTime()) && !Number.isNaN(parsedTo.getTime())
      ? { start: parsedFrom, end: parsedTo }
      : getDhakaDayRange(new Date());

  const rows: Array<Record<string, unknown>> =
    type === "team"
      ? (await getPerTeamMemberBreakdown(range)).map((r) => ({ Member: r.name, Activities: r.activityCount }))
      : type === "sessions"
        ? (await getSessionsForExport(range, groupId)).map((r) => ({
            Group: r.groupName,
            Status: r.status,
            "Started At": r.startedAt.toISOString(),
            "Started By": r.startedByName ?? "",
            "Completed At": r.completedAt?.toISOString() ?? "",
            "Completed By": r.completedByLabel ?? "",
            "Duration (seconds)": r.durationSeconds ?? "",
          }))
        : (await getActivitiesForExport(range, groupId)).map((r) => ({
            Time: r.occurredAt.toISOString(),
            Group: r.groupName,
            "Handled By": r.actor === "AI" ? "AI" : (r.teamMemberName ?? ""),
            "Actor": r.actor,
            Trigger: r.triggerType ?? "",
            Keyword: r.keywordValue ?? "",
            Message: r.messageBody,
          }));

  const baseName = `support-activity-${type}-${new Date().toISOString().slice(0, 10)}`;

  if (format === "csv") {
    return fileResponse(toCsv(rows), `${baseName}.csv`, "text/csv; charset=utf-8");
  }

  const sheetName = type === "team" ? "Team Performance" : type === "sessions" ? "Sessions" : "Activities";
  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return fileResponse(buffer, `${baseName}.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
}
