import { NextResponse, type NextRequest } from "next/server";
import * as XLSX from "xlsx";
import {
  buildReportRunMetadata,
  computeReportingReliability,
  countOperatorReplies,
  dataQualityLines,
  DUTY_SOURCE_LABELS,
  reliabilityLines,
  REPLY_CATEGORY_LABELS,
  replyCategoryOf,
  responseLines,
  runMetadataLines,
  sanitizeExcelRow,
} from "@support-automation/shared";
import { requireAccess } from "@/server/authorize";
import { prisma } from "@/server/db";
import { bucketLabel, CONTEXT_MS, exportStoredBy, LOOKAHEAD_MS, loadTeamReport, memberLabel, parseTeamReportFilters, reportNow, scopeLabel } from "@/server/teamReport";
import { loadDataHealth } from "@/server/dataHealth";
import { isUnifiedReportingEnabled, loadDataQualityCounts, loadPendingReattributions } from "@/server/unifiedReporting";

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

/** A download name with spaces and non-ASCII (Bangla team names) intact where browsers support it. */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * CSV Excel opens as UTF-8 (the byte-order mark — without it Bangla names come out garbled), with a
 * header row even when there are no rows, and every cell holding a quote, comma or line break quoted.
 */
function toCsv(rows: Array<Record<string, unknown>>, headers: string[]): string {
  const escapeCell = (value: unknown) => {
    const str = value === null || value === undefined ? "" : String(value);
    return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  return "\uFEFF" + [headers.map(escapeCell).join(","), ...rows.map((row) => headers.map((h) => escapeCell(row[h])).join(","))].join("\r\n");
}

const GROUP_COLUMNS = [
  "Group",
  "Group ID",
  "Assigned now",
  "Team members",
  "Messages",
  "Customer messages",
  "Team member replies",
  "Business number replies",
  "Customer waits",
  "Missed",
  "Recall",
  "Never answered",
  "First support",
  "Last support",
  "Support time (hours)",
];

export async function GET(request: NextRequest) {
  await requireAccess("support_activity.view");
  const params = Object.fromEntries(request.nextUrl.searchParams.entries());
  const format = params.format === "xlsx" ? "xlsx" : "csv";
  const now = reportNow(params);
  const { filters, range, result, memberNames, groups, rules, teamName, response, reliabilityCounts, messages } = await loadTeamReport(
    parseTeamReportFilters(params, now),
    now,
    undefined,
    exportStoredBy(params, now),
  );
  const memberName = filters.memberId ? memberLabel(filters.memberId, memberNames) : null;
  const scope = scopeLabel(teamName, memberName);
  const groupName = (key: string) => groups.get(key)?.name ?? key;

  const groupRows = result.groups.map((row) =>
    sanitizeExcelRow({
      Group: groupName(row.groupKey),
      "Group ID": row.groupKey,
      // Today's assignee, for finding the group; each Missed wait is charged to the assignee when the
      // customer asked (the "Missed & Recall" sheet's "Charged to").
      "Assigned now": groups.get(row.groupKey)?.assignedMemberId
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
      // Support time in the group, not overtime: overtime belongs to a person's day (TEAM_OVERTIME.md).
      "Support time (hours)": hours(row.activeSeconds),
    }),
  );

  // "Team Report - Support Team - September 2026": the file says what it is once it has left the page.
  // Only characters every filesystem accepts, so a team called "Sales/Retail" still downloads.
  const safe = (text: string) => text.replace(/[^\p{L}\p{N} .–_-]+/gu, " ").replace(/\s+/g, " ").trim();
  const slug = [teamName, memberName, range.label].filter(Boolean).map((part) => safe(part!)).join(" - ");

  if (format === "csv") {
    return new NextResponse(toCsv(groupRows, GROUP_COLUMNS), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": contentDisposition(`Team Report groups - ${slug}.csv`),
      },
    });
  }

  const { summary } = result;
  const health = await loadDataHealth({ periodStart: range.start.getTime(), periodEnd: range.end.getTime(), now, accountId: filters.accountId });
  const summaryRows = [
    { Metric: "Report", Value: `${scope} · ${range.label}` },
    { Metric: "Team", Value: teamName ?? "All teams" },
    { Metric: "Team member", Value: memberName ?? "All" },
    { Metric: "Breakdown", Value: filters.granularity },
    // Only when chosen, so a report without them exports exactly what it always did.
    ...(filters.groupKeys?.length ? [{ Metric: "Groups", Value: filters.groupKeys.map(groupName).join(", ") }] : []),
    ...(filters.accountId
      ? [
          {
            Metric: "WhatsApp account",
            Value: (await prisma.whatsAppAccount.findFirst({ where: { id: filters.accountId }, select: { label: true } }))?.label ?? filters.accountId,
          },
        ]
      : []),
    { Metric: "Period start (Asia/Dhaka)", Value: iso(range.start.getTime()) },
    { Metric: "Period end (Asia/Dhaka, exclusive)", Value: iso(range.end.getTime()) },
    { Metric: "Computed as of", Value: iso(now.getTime()) },
    // How far the figures can be trusted — the same reading the page shows above them.
    { Metric: "Data health", Value: health.label },
    { Metric: "Data health detail", Value: health.headline },
    { Metric: "Verified from (Asia/Dhaka)", Value: health.verifiedFrom ? iso(health.verifiedFrom) : "Not set" },
    ...health.warnings.map((w) => ({ Metric: "Data caveat", Value: w })),
    { Metric: "Groups supported", Value: summary.groupsSupported },
    { Metric: "Customer messages", Value: summary.customerMessages },
    { Metric: "Team member replies", Value: summary.memberReplies },
    // Staff the roster cannot name (an identity clash, or a member since removed): in the total above,
    // in no person's row — so the Team Members sheet adding up to less is explained.
    ...(summary.unattributedStaffReplies > 0
      ? [{ Metric: "  of which by a team member not identified", Value: summary.unattributedStaffReplies }]
      : []),
    { Metric: "Business number replies", Value: summary.businessReplies },
    { Metric: "Customer waits", Value: summary.waits },
    { Metric: "Missed", Value: summary.missed },
    { Metric: "Recall support", Value: summary.recalled },
    { Metric: "Never answered", Value: summary.unrecovered },
    { Metric: "Support Overtime (hours)", Value: hours(summary.overtimeSeconds) },
    { Metric: "Member-days with no schedule (default duty length used)", Value: summary.unscheduledMemberDays },
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
      "Support Overtime (hours)": hours(row.overtimeSeconds),
      "Days with no schedule": row.unscheduledDays,
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
      "Support Overtime (hours)": hours(b.overtimeSeconds),
    }),
  );

  // The breakdown behind every overtime figure: one row per person per day with recorded work. The
  // schedule column says where the day's regular duty came from — never how long it was.
  const overtimeDayRows = result.overtimeDays.map((d) =>
    sanitizeExcelRow({
      "Team member": memberLabel(d.memberId, memberNames),
      Date: d.day,
      "Support Overtime (hours)": hours(d.overtimeSeconds),
      Schedule: DUTY_SOURCE_LABELS[d.source],
    }),
  );

  // Every wait that went past its threshold — the rows behind the Missed and Recall figures.
  const missedRows = result.countedMissedWaits.map((w) =>
      sanitizeExcelRow({
        Group: groupName(w.groupKey),
        "Group ID": w.groupKey,
        "Customer asked": iso(w.askedAt),
        Answered: iso(w.repliedAt),
        "Wait (minutes)": w.waitSeconds === null ? "" : Math.round(w.waitSeconds / 60),
        "Threshold (minutes)": Math.round(w.thresholdSeconds / 60),
        "Answered by": w.repliedBy ? memberLabel(w.repliedBy, memberNames) : w.repliedAt !== null ? "A team member (not identified)" : "",
        // The assignee when the customer asked — the Team Members sheet's own rule, so the two agree.
        "Charged to": memberLabel(w.chargedTo, memberNames),
        Result: WAIT_RESULT[w.status] ?? w.status,
        // Who sent the reply that ended the wait, from the send it echoes (teamReportReliability.ts).
        "Reply came from": w.repliedByActor ? REPLY_CATEGORY_LABELS[replyCategoryOf(w.repliedByActor)] : "",
      }),
    );

  // The page's "How customers were answered" and "Reporting reliability" sections, line for line.
  const reliability = computeReportingReliability(reliabilityCounts, health, { start: range.start.getTime(), end: range.end.getTime(), now: now.getTime() });
  // Unified messaging reports (UNIFIED_REPORTING) only: the page's "Collection detail" lines in the same
  // sheet, and a "Run information" sheet after the existing ones. Off, the workbook is what it always was.
  const unified = await isUnifiedReportingEnabled();
  const stored = exportStoredBy(params, now).storedBy;
  const [quality, pendingReattributions] = unified
    ? await Promise.all([
        loadDataQualityCounts({ kind: "GROUP", start: range.start, end: range.end, storedBy: stored, accountId: filters.accountId, groupKeys: filters.groupKeys }),
        loadPendingReattributions(),
      ])
    : [null, 0];
  const qualityRows = [
    ...responseLines(response),
    ...reliabilityLines(reliability),
    ...(quality ? dataQualityLines(quality, "GROUP", pendingReattributions) : []),
  ].map((line) => sanitizeExcelRow({ Section: line.section, Measure: line.label, Value: line.value, Note: line.note }));
  const runRows = quality
    ? runMetadataLines(
        buildReportRunMetadata({
          scope: "group",
          generatedAt: now.getTime(),
          storedBy: stored?.getTime() ?? null,
          period: {
            start: range.start.getTime(),
            end: range.end.getTime(),
            label: range.label,
            contextMs: CONTEXT_MS,
            lookaheadMs: LOOKAHEAD_MS,
            name: { day: "Daily", week: "Weekly", month: "Monthly", custom: "Custom range" }[filters.period],
          },
          filters: {
            team: teamName,
            member: memberName,
            groupCount: filters.groupKeys?.length ?? 0,
            account: filters.accountId
              ? ((await prisma.whatsAppAccount.findFirst({ where: { id: filters.accountId }, select: { label: true } }))?.label ?? filters.accountId)
              : null,
            granularity: filters.granularity,
          },
          health,
          reliability,
          operatorReplies: countOperatorReplies(messages, range.end.getTime()),
          pendingReattributions,
        }),
      ).map((line) => sanitizeExcelRow({ Item: line.label, Value: line.value, Note: line.note }))
    : [];

  const workbook = XLSX.utils.book_new();
  const addSheet = (name: string, rows: Array<Record<string, unknown>>, emptyNote: string) =>
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows.length ? rows : [{ Note: emptyNote }]), name);
  addSheet("Summary", summaryRows, "");
  if (!filters.memberId) addSheet("Team Members", memberRows, "No team member activity in this period.");
  addSheet("Groups", groupRows, "No group messages in this period.");
  addSheet(filters.granularity === "day" ? "Daily" : filters.granularity === "week" ? "Weekly" : "Monthly", bucketRows, "");
  addSheet("Missed & Recall", missedRows, "Nothing was missed in this period.");
  addSheet("Overtime by day", overtimeDayRows, "No team member work was recorded in this period.");
  addSheet("Data quality", qualityRows, "");
  if (quality) addSheet("Run information", runRows, "");

  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return new NextResponse(buffer as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": contentDisposition(`Team Report - ${slug}.xlsx`),
    },
  });
}
