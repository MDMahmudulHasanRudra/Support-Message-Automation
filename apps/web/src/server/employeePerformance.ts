import {
  COMPARE_MEASURES,
  compareEmployeePeriods,
  computeEmployeeAnalytics,
  formatDhakaDateKey,
  previousPeriod,
  RANK_MEASURES,
  type CompareMeasure,
  type EmployeeAnalytics,
  type RankCell,
} from "@support-automation/shared";
import { loadTeamReport, bucketLabel, memberLabel, teamReportQuery, type TeamReportData } from "@/server/teamReport";
import { formatDuration, type ReportTableData, type ReportTableRow } from "@/server/teamReportTables";

/**
 * Employee ranking, daily engagement and period comparison for the Team Report (UNIFIED_REPORTING, WP10).
 *
 * Everything is derived from the SAME `TeamReportData` the page's other tables are built from — its
 * classified messages, its scope and its `computeTeamReport` result — through the pure functions in
 * packages/shared (employeeRanking.ts). Nothing here reads a message or decides who sent one.
 *
 * The comparison loads the previous period of equal length through `loadTeamReport` once more, only
 * when asked for (`compare=1`), with the same filters, so its figures are the Team Report's own.
 */

export function analyticsOf(report: TeamReportData): EmployeeAnalytics {
  return computeEmployeeAnalytics({
    messages: report.messages,
    result: report.result,
    rangeStart: report.range.start.getTime(),
    rangeEnd: report.range.end.getTime(),
    scope: report.scope,
  });
}

export interface PreviousPeriodReport {
  report: TeamReportData;
  analytics: EmployeeAnalytics;
}

/**
 * The previous period of equal length, loaded exactly like this one (same Team, member, groups and account),
 * or null with the reason when it cannot mean the same report: a member or Team that does not apply to it.
 */
export async function loadPreviousPeriod(
  report: TeamReportData,
  now: Date,
  options: { storedBy?: Date } = {},
): Promise<{ previous: PreviousPeriodReport | null; note: string | null; partial: boolean }> {
  const prev = previousPeriod(report.range.start.getTime(), report.range.end.getTime(), now.getTime());
  const { compare: _compare, ...filters } = report.filters;
  void _compare;
  const data = await loadTeamReport(
    {
      ...filters,
      period: "custom",
      from: formatDhakaDateKey(new Date(prev.start)),
      to: formatDhakaDateKey(new Date(prev.end - 1)),
    },
    now,
    undefined,
    options,
  );
  // A Team the member was not in during the earlier period would silently widen to the whole Team: not the same report.
  if (data.filters.memberId !== report.filters.memberId || data.filters.teamId !== report.filters.teamId) {
    return { previous: null, note: data.filterNote ?? "The same Team and member filter does not apply to the previous period, so there is nothing to compare.", partial: prev.partial };
  }
  return { previous: { report: data, analytics: analyticsOf(data) }, note: null, partial: prev.partial };
}

const NOT_ENOUGH = "Not enough data";

const rankText = (cell: RankCell): string | number => (cell.status === "RANKED" ? cell.rank : NOT_ENOUGH);
const rankSort = (cell: RankCell): number => (cell.status === "RANKED" ? cell.rank : 1_000_000);
const toneOf = (cell: RankCell): "good" | "bad" | null => (cell.status === "RANKED" ? (cell.highlight === "top" ? "good" : cell.highlight === "behind" ? "bad" : null) : null);
const oneDecimal = (n: number) => Math.round(n * 10) / 10;

const RANKING_HINTS: Record<string, string> = {
  groupsEngaged: "Distinct WhatsApp groups with this person's messages in the period. For a one-day period this is the Groups column of the Team members table.",
  replies: "Messages this person sent in groups.",
  activeDays: "Asia/Dhaka days with any message of this person's.",
  avgGroupsPerActiveDay: "The groups engaged each day, added up, divided by the active days.",
  supportSeconds: "Support time as the Team Report measures it: first to last message of each work stretch.",
  missed: "Waits charged to this person (assignee when the customer asked) that went past their time. Fewer is better.",
  medianResponseSeconds: "Median of the waits this person's reply closed. Shorter is better. Needs at least 5 closed waits.",
};

export function buildRankingTable(report: TeamReportData, analytics: EmployeeAnalytics): ReportTableData {
  const columns: ReportTableData["columns"] = [{ label: "Team member" }];
  for (const m of RANK_MEASURES) {
    columns.push({ label: m.label, numeric: true, hint: RANKING_HINTS[m.id] });
    columns.push({ label: `${m.label} rank`, numeric: true, hint: `Rank on this measure alone, ${m.better === "higher" ? "most first" : "fewest first"}. Ties share a rank. "${NOT_ENOUGH}" is never a last place.` });
  }
  const rows: ReportTableRow[] = analytics.rows.map((row) => {
    const name = memberLabel(row.memberId, report.memberNames);
    const value: Record<string, string | number> = {
      groupsEngaged: row.groupsEngaged,
      replies: row.replies,
      activeDays: row.activeDays,
      avgGroupsPerActiveDay: row.avgGroupsPerActiveDay === null ? "—" : oneDecimal(row.avgGroupsPerActiveDay),
      supportSeconds: formatDuration(row.supportSeconds),
      missed: row.missed,
      medianResponseSeconds: row.medianResponseSeconds === null ? "—" : formatDuration(row.medianResponseSeconds),
    };
    const raw: Record<string, number> = {
      groupsEngaged: row.groupsEngaged,
      replies: row.replies,
      activeDays: row.activeDays,
      avgGroupsPerActiveDay: row.avgGroupsPerActiveDay ?? -1,
      supportSeconds: row.supportSeconds,
      missed: row.missed,
      medianResponseSeconds: row.medianResponseSeconds ?? -1,
    };
    const cells: Array<string | number> = [name];
    const sort: Array<string | number> = [name.toLowerCase()];
    const tones: Array<"good" | "bad" | null> = [null];
    const sub: Array<string | null> = [null];
    for (const m of RANK_MEASURES) {
      const rank = row.ranks[m.id];
      cells.push(value[m.id]!, rankText(rank));
      sort.push(raw[m.id]!, rankSort(rank));
      tones.push(toneOf(rank), toneOf(rank));
      sub.push(m.id === "medianResponseSeconds" ? `${row.closedWaits} closed wait${row.closedWaits === 1 ? "" : "s"}` : null, null);
    }
    return { key: row.memberId, cells, sort, tones, sub, href: `/team-report?${teamReportQuery(report.filters, { memberId: row.memberId })}` };
  });
  return { id: "ranking", columns, rows };
}

// A change is a plain number (negative = fewer), and a time change is worded ("more" / "less") rather than signed:
// a text cell starting with "+" or "-" is made formula-safe in a spreadsheet and would print with a stray apostrophe.
const changeDuration = (seconds: number) => (seconds > 0 ? `${formatDuration(seconds)} more` : seconds < 0 ? `${formatDuration(-seconds)} less` : "no change");

export function buildComparisonTable(
  now: EmployeeAnalytics,
  then: EmployeeAnalytics,
  names: Map<string, string>,
  filters: TeamReportData["filters"],
): ReportTableData {
  const columns: ReportTableData["columns"] = [{ label: "Team member" }];
  for (const m of COMPARE_MEASURES) {
    columns.push({ label: `${m.label} (before)`, numeric: true }, { label: `${m.label} (now)`, numeric: true }, { label: `${m.label} change`, numeric: true });
  }
  const isTime = (id: CompareMeasure) => id === "supportSeconds";
  const rows: ReportTableRow[] = compareEmployeePeriods(now, then).map((row) => {
    const name = memberLabel(row.memberId, names);
    const cells: Array<string | number> = [name];
    const sort: Array<string | number> = [name.toLowerCase()];
    const tones: Array<"good" | "bad" | null> = [null];
    for (const m of COMPARE_MEASURES) {
      const f = row.figures[m.id];
      cells.push(isTime(m.id) ? formatDuration(f.then) : f.then, isTime(m.id) ? formatDuration(f.now) : f.now, isTime(m.id) ? changeDuration(f.change) : f.change);
      sort.push(f.then, f.now, f.change);
      // Fewer missed is better; every other measure is better when it is higher.
      const better = m.id === "missed" ? f.change < 0 : f.change > 0;
      const worse = m.id === "missed" ? f.change > 0 : f.change < 0;
      tones.push(null, null, better ? "good" : worse ? "bad" : null);
    }
    return { key: row.memberId, cells, sort, tones, href: `/team-report?${teamReportQuery(filters, { memberId: row.memberId })}` };
  });
  return { id: "comparison", columns, rows };
}

/** The daily grid as plain rows for the workbook: one row per person plus the day totals, one column per Dhaka day. */
export function buildDailyEngagementSheetTable(analytics: EmployeeAnalytics, names: Map<string, string>): ReportTableData {
  const dayLabels = analytics.days.map((d) => bucketLabel(d, "day"));
  const columns: ReportTableData["columns"] = [
    { label: "Team member" },
    { label: "Distinct groups (period)", numeric: true },
    { label: "Sum of daily engagements", numeric: true },
    { label: "Active days", numeric: true },
    { label: "Avg groups per active day", numeric: true },
    ...dayLabels.map((label) => ({ label, numeric: true })),
  ];
  const rows: ReportTableRow[] = analytics.daily.members.map((m) => ({
    key: m.memberId,
    cells: [memberLabel(m.memberId, names), m.distinctGroups, m.sumOfDays, m.activeDays, m.avgPerActiveDay === null ? "" : oneDecimal(m.avgPerActiveDay), ...m.perDay],
    sort: [],
  }));
  const activeDays = analytics.daily.dayTotals.filter((n) => n > 0).length;
  rows.push({
    key: "__total",
    cells: [
      "All members in scope (distinct groups per day)",
      analytics.daily.distinctOverall,
      analytics.daily.sumOfDayTotals,
      activeDays,
      activeDays > 0 ? oneDecimal(analytics.daily.sumOfDayTotals / activeDays) : "",
      ...analytics.daily.dayTotals,
    ],
    sort: [],
  });
  return { id: "daily-engagement", columns, rows };
}

export const EMPLOYEE_TABLE_IDS = ["ranking", "comparison"] as const;
export type EmployeeTableId = (typeof EMPLOYEE_TABLE_IDS)[number];
export function isEmployeeTableId(value: unknown): value is EmployeeTableId {
  return typeof value === "string" && (EMPLOYEE_TABLE_IDS as readonly string[]).includes(value);
}
