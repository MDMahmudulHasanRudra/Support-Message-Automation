import { bucketKeyFor, bucketKeysForRange, UNASSIGNED, type ReportMessage, type TeamReportResult } from "../teamReport.js";

/**
 * Employee ranking, daily engagement and period comparison (unified reporting WP10).
 *
 * Pure derivations over the SAME classified messages and the SAME `computeTeamReport` result the Team
 * Report's tables are built from. Nothing here classifies a message or re-decides who sent it, and
 * nothing re-computes a figure the report already has: replies, support time and missed are read off the
 * member rows, and "groups engaged" is derived with the rule `computeTeamReport` uses for a member's
 * `groups` (distinct groups with the member's messages in the period, in scope at that moment), so the
 * two cannot disagree. A test pins that equality for every member of a period.
 *
 * There is NO blended score. Each measure is ranked on its own; a person can be first on one and behind
 * on another. A measure is ranked only when the person has enough data behind it (the sample guard),
 * and a person without enough data is "not enough data", never last.
 */

export const RANKING_VERSION = "employee-ranking-1";
/** Fewer active Dhaka days than this (or than the period has, for a shorter period) = not enough data. */
export const MIN_ACTIVE_DAYS_FOR_RANK = 3;
/** Fewer closed waits than this = no response-time rank. */
export const MIN_CLOSED_WAITS_FOR_MEDIAN = 5;
/** The number of people highlighted as top / behind. */
export const HIGHLIGHT_COUNT = 3;

export type RankMeasure =
  | "groupsEngaged"
  | "replies"
  | "activeDays"
  | "avgGroupsPerActiveDay"
  | "supportSeconds"
  | "missed"
  | "medianResponseSeconds";

export const RANK_MEASURES: ReadonlyArray<{ id: RankMeasure; label: string; better: "higher" | "lower" }> = [
  { id: "groupsEngaged", label: "Groups engaged", better: "higher" },
  { id: "replies", label: "Replies", better: "higher" },
  { id: "activeDays", label: "Active days", better: "higher" },
  { id: "avgGroupsPerActiveDay", label: "Avg groups per active day", better: "higher" },
  { id: "supportSeconds", label: "Support time", better: "higher" },
  { id: "missed", label: "Missed (charged to them)", better: "lower" },
  { id: "medianResponseSeconds", label: "Median response time", better: "lower" },
];

export type RankCell =
  | { status: "RANKED"; rank: number; of: number; highlight: "top" | "behind" | null }
  | { status: "NOT_ENOUGH_DATA" };

export interface EmployeeRankingRow {
  memberId: string;
  groupsEngaged: number;
  replies: number;
  activeDays: number;
  /** Sum of the daily distinct-group counts divided by the active days; null with no active day. */
  avgGroupsPerActiveDay: number | null;
  supportSeconds: number;
  missed: number;
  /** Waits this person's reply closed (in scope, started in the period). */
  closedWaits: number;
  medianResponseSeconds: number | null;
  ranks: Record<RankMeasure, RankCell>;
}

export interface DailyEngagementRow {
  memberId: string;
  /** Aligned with `days`: distinct groups engaged that day. */
  perDay: number[];
  /** The sum of the daily counts: a group worked on three days counts three times. */
  sumOfDays: number;
  /** Distinct groups over the whole period: a group worked on three days counts once. */
  distinctGroups: number;
  activeDays: number;
  avgPerActiveDay: number | null;
}

export interface EmployeeAnalytics {
  version: typeof RANKING_VERSION;
  /** Dhaka day keys of the period, oldest first. */
  days: string[];
  rows: EmployeeRankingRow[];
  daily: {
    members: DailyEngagementRow[];
    /** Aligned with `days`: distinct groups engaged that day by anyone in scope. */
    dayTotals: number[];
    /** Distinct groups over the period by anyone in scope. */
    distinctOverall: number;
    sumOfDayTotals: number;
  };
  /** The active-days guard actually applied (3, or fewer for a period of fewer days). */
  minActiveDays: number;
}

export interface EmployeeAnalyticsInput {
  messages: readonly ReportMessage[];
  result: TeamReportResult;
  rangeStart: number;
  rangeEnd: number;
  /** The scope `computeTeamReport` applied (null = the whole team). */
  scope: ((memberId: string, ts: number) => boolean) | null;
}

const DAY_MS = 86_400_000;

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** Competition ranking: ties share a rank and the next rank skips (1, 2, 2, 4). */
export function rankValues(
  entries: ReadonlyArray<{ id: string; value: number }>,
  better: "higher" | "lower",
): Map<string, Extract<RankCell, { status: "RANKED" }>> {
  const sign = better === "higher" ? -1 : 1;
  const sorted = [...entries].sort((a, b) => sign * (a.value - b.value) || a.id.localeCompare(b.id));
  const out = new Map<string, Extract<RankCell, { status: "RANKED" }>>();
  const of = sorted.length;
  const allEqual = of > 0 && sorted.every((e) => e.value === sorted[0]!.value);
  // From the worst end too, so ties at the bottom share a "behind" position as ties at the top share a rank.
  const reversed = [...sorted].reverse();
  const reverseRank = new Map<string, number>();
  reversed.forEach((e, i) => {
    reverseRank.set(e.id, i > 0 && e.value === reversed[i - 1]!.value ? reverseRank.get(reversed[i - 1]!.id)! : i + 1);
  });
  sorted.forEach((e, i) => {
    const rank = i > 0 && e.value === sorted[i - 1]!.value ? out.get(sorted[i - 1]!.id)!.rank : i + 1;
    const top = rank <= HIGHLIGHT_COUNT;
    // Behind only with people clearly ahead of it: with fewer than four ranked, or all equal, nobody is.
    const behind = !top && of >= HIGHLIGHT_COUNT + 1 && reverseRank.get(e.id)! <= HIGHLIGHT_COUNT;
    out.set(e.id, { status: "RANKED", rank, of, highlight: allEqual ? null : top ? "top" : behind ? "behind" : null });
  });
  return out;
}

export function computeEmployeeAnalytics(input: EmployeeAnalyticsInput): EmployeeAnalytics {
  const { messages, result, rangeStart, rangeEnd, scope } = input;
  const days = bucketKeysForRange(rangeStart, rangeEnd, "day");
  const dayIndex = new Map(days.map((d, i) => [d, i]));
  const inRange = (ts: number) => ts >= rangeStart && ts < rangeEnd;

  // member -> day index -> groups; the same message filter computeTeamReport applies to a member's `groups`.
  const perMemberDay = new Map<string, Array<Set<string>>>();
  const perMemberGroups = new Map<string, Set<string>>();
  const dayAll: Array<Set<string>> = days.map(() => new Set());
  const overall = new Set<string>();
  for (const m of messages) {
    if (m.kind !== "MEMBER" || !m.memberId || !inRange(m.ts)) continue;
    if (scope && !scope(m.memberId, m.ts)) continue;
    const idx = dayIndex.get(bucketKeyFor(m.ts, "day"));
    if (idx === undefined) continue;
    let perDay = perMemberDay.get(m.memberId);
    if (!perDay) {
      perDay = days.map(() => new Set<string>());
      perMemberDay.set(m.memberId, perDay);
    }
    perDay[idx]!.add(m.groupKey);
    dayAll[idx]!.add(m.groupKey);
    overall.add(m.groupKey);
    let groups = perMemberGroups.get(m.memberId);
    if (!groups) {
      groups = new Set();
      perMemberGroups.set(m.memberId, groups);
    }
    groups.add(m.groupKey);
  }

  const dailyMembers: DailyEngagementRow[] = [...perMemberDay.entries()]
    .map(([memberId, perDaySets]) => {
      const perDay = perDaySets.map((s) => s.size);
      const sumOfDays = perDay.reduce((a, b) => a + b, 0);
      const activeDays = perDay.filter((n) => n > 0).length;
      return {
        memberId,
        perDay,
        sumOfDays,
        distinctGroups: perMemberGroups.get(memberId)?.size ?? 0,
        activeDays,
        avgPerActiveDay: activeDays > 0 ? sumOfDays / activeDays : null,
      };
    })
    .sort((a, b) => b.distinctGroups - a.distinctGroups || b.sumOfDays - a.sumOfDays || a.memberId.localeCompare(b.memberId));
  const dailyById = new Map(dailyMembers.map((r) => [r.memberId, r]));

  // The waits each person's reply closed (those that started in the period, as every wait does).
  const closed = new Map<string, number[]>();
  for (const w of result.waits) {
    if (!w.repliedBy || w.repliedBy === "BUSINESS" || w.repliedAt === null || w.waitSeconds === null) continue;
    if (scope && !scope(w.repliedBy, w.repliedAt)) continue;
    const list = closed.get(w.repliedBy);
    if (list) list.push(w.waitSeconds);
    else closed.set(w.repliedBy, [w.waitSeconds]);
  }

  const minActiveDays = Math.min(MIN_ACTIVE_DAYS_FOR_RANK, Math.max(1, days.length));
  const rows: EmployeeRankingRow[] = result.members
    .filter((r) => r.memberId !== UNASSIGNED)
    .map((row) => {
      const daily = dailyById.get(row.memberId);
      const waits = closed.get(row.memberId) ?? [];
      return {
        memberId: row.memberId,
        groupsEngaged: daily?.distinctGroups ?? 0,
        replies: row.messages,
        activeDays: daily?.activeDays ?? 0,
        avgGroupsPerActiveDay: daily?.avgPerActiveDay ?? null,
        supportSeconds: row.activeSeconds,
        missed: row.missed,
        closedWaits: waits.length,
        medianResponseSeconds: median(waits),
        ranks: {} as Record<RankMeasure, RankCell>,
      };
    });

  for (const measure of RANK_MEASURES) {
    // Active days is the sample itself, so it is ranked for anybody who worked; every other measure needs the
    // sample, and the response median needs enough closed waits as well.
    const eligible = rows.filter((r) => {
      if (measure.id === "activeDays") return r.activeDays > 0;
      if (measure.id === "medianResponseSeconds") return r.activeDays >= minActiveDays && r.closedWaits >= MIN_CLOSED_WAITS_FOR_MEDIAN;
      return r.activeDays >= minActiveDays;
    });
    const ranked = rankValues(
      eligible.map((r) => ({ id: r.memberId, value: (r[measure.id] ?? 0) as number })),
      measure.better,
    );
    for (const r of rows) r.ranks[measure.id] = ranked.get(r.memberId) ?? { status: "NOT_ENOUGH_DATA" };
  }
  rows.sort((a, b) => b.groupsEngaged - a.groupsEngaged || b.replies - a.replies || a.memberId.localeCompare(b.memberId));

  return {
    version: RANKING_VERSION,
    days,
    rows,
    daily: {
      members: dailyMembers,
      dayTotals: dayAll.map((s) => s.size),
      distinctOverall: overall.size,
      sumOfDayTotals: dayAll.reduce((a, s) => a + s.size, 0),
    },
    minActiveDays,
  };
}

// ---------------------------------------------------------------------------------------------
// Period comparison
// ---------------------------------------------------------------------------------------------

export type CompareMeasure = "groupsEngaged" | "replies" | "activeDays" | "supportSeconds" | "missed";
export const COMPARE_MEASURES: ReadonlyArray<{ id: CompareMeasure; label: string }> = [
  { id: "groupsEngaged", label: "Groups engaged" },
  { id: "replies", label: "Replies" },
  { id: "activeDays", label: "Active days" },
  { id: "supportSeconds", label: "Support time" },
  { id: "missed", label: "Missed" },
];

export interface ComparisonRow {
  memberId: string;
  /** For each measure: the previous period, this period, and now minus then. */
  figures: Record<CompareMeasure, { then: number; now: number; change: number }>;
}

/** Every member with activity in either period; a member absent from one period has 0 in it. */
export function compareEmployeePeriods(now: EmployeeAnalytics, then: EmployeeAnalytics): ComparisonRow[] {
  const nowBy = new Map(now.rows.map((r) => [r.memberId, r]));
  const thenBy = new Map(then.rows.map((r) => [r.memberId, r]));
  const ids = [...new Set([...nowBy.keys(), ...thenBy.keys()])];
  const rows = ids.map((memberId): ComparisonRow => {
    const a = nowBy.get(memberId);
    const b = thenBy.get(memberId);
    const figures = {} as ComparisonRow["figures"];
    for (const { id } of COMPARE_MEASURES) {
      const n = a?.[id] ?? 0;
      const t = b?.[id] ?? 0;
      figures[id] = { then: t, now: n, change: n - t };
    }
    return { memberId, figures };
  });
  return rows.sort((x, y) => y.figures.groupsEngaged.now - x.figures.groupsEngaged.now || x.memberId.localeCompare(y.memberId));
}

/** The previous period of equal length: [start - length, start). Dhaka has no DST, so whole days stay whole days. */
export function previousPeriod(rangeStart: number, rangeEnd: number): { start: number; end: number; days: number } {
  const length = rangeEnd - rangeStart;
  return { start: rangeStart - length, end: rangeStart, days: Math.round(length / DAY_MS) };
}
