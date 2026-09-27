import { NextResponse, type NextRequest } from "next/server";
import * as XLSX from "xlsx";
import { sanitizeExcelRow } from "@support-automation/shared";
import { requireAccess } from "@/server/authorize";
import { bucketLabel, loadTeamReport, memberLabel, parseTeamReportFilters } from "@/server/teamReport";

/**
 * Team Report export. A Route Handler because a file download cannot come from a Server Action —
 * the same reason the Support Activity export exists.
 *
 * It runs the very same `loadTeamReport` the page does, with the very same filters from the URL, so
 * the file cannot disagree with the screen it was downloaded from. CSV is the group list (the
 * report's main table); Excel is the whole report, one sheet per section. Every text cell goes
 * through `sanitizeExcelRow`: group and member names are typed by people, and a name starting with
 * "=" must not become a formula in somebody's spreadsheet.
 */

const hours = (seconds: number) => Math.round((seconds / 3600) * 100) / 100;
const iso = (ms: number | null) =>
  ms === null
    ? ""
    : new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Asia/Dhaka",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(new Date(ms));

const WAIT_RESULT: Record<string, string> = {
  ON_TIME: "Answered in time",
  RECALLED: "Recall (answered late)",
  MISSED: "Missed (never answered)",
  PENDING: "Still within time",
};

function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]!);
  const escapeCell = (value: unknown) => {
    const str = value === null || value === undefined ? "" : String(value);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  return [headers.join(","), ...rows.map((row) => headers.map((h) => escapeCell(row[h])).join(","))].join("\n");
}

export async function GET(request: NextRequest) {
  await requireAccess("support_activity.view");
  const params = Object.fromEntries(request.nextUrl.searchParams.entries());
  const format = params.format === "xlsx" ? "xlsx" : "csv";
  const now = new Date();
  const filters = parseTeamReportFilters(params, now);
  const { range, result, memberNames, groups, rules } = await loadTeamReport(filters, now);
  const scope = filters.memberId ? memberLabel(filters.memberId, memberNames) : "All team members";
  const groupName = (key: string) => groups.get(key)?.name ?? key;

  const groupRows = result.groups.map((row) =>
    sanitizeExcelRow({
      Group: groupName(row.groupKey),
      "Group ID": row.groupKey,
      "Assigned to": groups.get(row.groupKey)?.assignedMemberId
        ? memberLabel(groups.get(row.groupKey)!.assignedMemberId, memberNames)
        : "",
      "Team members": row.memberIds.map((id) => memberLabel(id, memberNames)).join(", "),
      Messages: row.totalMessages,
      "Customer messages": row.customerMessages,
      "Team member replies": row.memberReplies,
      "Business number replies": row.businessReplies,
      "Customer waits": row.waits,
      Missed: row.missed,
      Recall: row.recalled,
      "Never answered": row.unrecovered,
      "First support": iso(row.firstActivityAt),
      "Last support": iso(row.lastActivityAt),
      "Support hours": hours(row.activeSeconds),
    }),
  );

  const slug = `${range.start.toISOString().slice(0, 10)}_${filters.period}${filters.memberId ? "_member" : ""}`;

  if (format === "csv") {
    return new NextResponse(toCsv(groupRows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="team-report-groups_${slug}.csv"`,
      },
    });
  }

  const { summary } = result;
  const summaryRows = [
    { Metric: "Report", Value: `${scope} · ${range.label}` },
    { Metric: "Period start (Asia/Dhaka)", Value: iso(range.start.getTime()) },
    { Metric: "Period end (Asia/Dhaka, exclusive)", Value: iso(range.end.getTime()) },
    { Metric: "Groups supported", Value: summary.groupsSupported },
    { Metric: "Customer messages", Value: summary.customerMessages },
    { Metric: "Team member replies", Value: summary.memberReplies },
    { Metric: "Business number replies", Value: summary.businessReplies },
    { Metric: "Customer waits", Value: summary.waits },
    { Metric: "Missed", Value: summary.missed },
    { Metric: "Recall support", Value: summary.recalled },
    { Metric: "Never answered", Value: summary.unrecovered },
    { Metric: "Support hours", Value: hours(summary.activeSeconds) },
    { Metric: "Active team members", Value: summary.activeMembers },
    { Metric: "Last activity", Value: iso(summary.lastActivityAt) },
    { Metric: "Rule: missed after (minutes, groups without a priority)", Value: rules.missedAfterMinutes },
    ...Object.entries(rules.policyMinutes).map(([priority, minutes]) => ({
      Metric: `Rule: missed after for priority ${priority} (escalation first alert, minutes)`,
      Value: minutes,
    })),
    { Metric: "Rule: new work stretch after (minutes idle)", Value: rules.idleGapMinutes },
  ].map((row) => sanitizeExcelRow(row));

  const memberRows = result.members.map((row) =>
    sanitizeExcelRow({
      "Team member": row.memberId === "UNASSIGNED" ? "Unassigned groups" : memberLabel(row.memberId, memberNames),
      Groups: row.groups,
      Replies: row.messages,
      "Customer messages (their groups)": row.customerMessages,
      "Missed (assigned groups)": row.missed,
      "Recall (answered late)": row.recalled,
      "Never answered": row.unrecovered,
      "Support hours": hours(row.activeSeconds),
      "Work stretches": row.stretches,
      "First activity": iso(row.firstAt),
      "Last activity": iso(row.lastAt),
    }),
  );

  const bucketRows = result.buckets.map((b) =>
    sanitizeExcelRow({
      [filters.granularity === "day" ? "Date" : filters.granularity === "week" ? "Week" : "Month"]: bucketLabel(b.key, filters.granularity),
      Key: b.key,
      Groups: b.groups,
      "Team member replies": b.memberMessages,
      "Business number replies": b.businessReplies,
      "Customer messages": b.customerMessages,
      Missed: b.missed,
      Recall: b.recalled,
      "Support hours": hours(b.activeSeconds),
    }),
  );

  // Every wait that went past its threshold — the rows behind the Missed and Recall figures.
  const missedRows = result.waits
    .filter((w) => w.status === "RECALLED" || w.status === "MISSED")
    .map((w) =>
      sanitizeExcelRow({
        Group: groupName(w.groupKey),
        "Group ID": w.groupKey,
        "Customer asked": iso(w.askedAt),
        Answered: iso(w.repliedAt),
        "Wait (minutes)": w.waitSeconds === null ? "" : Math.round(w.waitSeconds / 60),
        "Threshold (minutes)": Math.round(w.thresholdSeconds / 60),
        "Answered by": w.repliedBy ? memberLabel(w.repliedBy, memberNames) : "",
        "Charged to": memberLabel(groups.get(w.groupKey)?.assignedMemberId ?? null, memberNames),
        Result: WAIT_RESULT[w.status] ?? w.status,
      }),
    );

  const workbook = XLSX.utils.book_new();
  const addSheet = (name: string, rows: Array<Record<string, unknown>>, emptyNote: string) =>
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows.length ? rows : [{ Note: emptyNote }]), name);
  addSheet("Summary", summaryRows, "");
  if (!filters.memberId) addSheet("Team Members", memberRows, "No team member activity in this period.");
  addSheet("Groups", groupRows, "No group messages in this period.");
  addSheet(filters.granularity === "day" ? "Daily" : filters.granularity === "week" ? "Weekly" : "Monthly", bucketRows, "");
  addSheet("Missed & Recall", missedRows, "Nothing was missed in this period.");

  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return new NextResponse(buffer as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="team-report_${slug}.xlsx"`,
    },
  });
}
