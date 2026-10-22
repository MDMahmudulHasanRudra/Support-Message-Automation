import { describe, expect, it } from "vitest";
import { computeTeamReport, type ReportMessage, type TeamReportOptions } from "../teamReport.js";
import {
  compareEmployeePeriods,
  computeEmployeeAnalytics,
  MIN_CLOSED_WAITS_FOR_MEDIAN,
  previousPeriod,
  rankValues,
} from "../unifiedReporting/employeeRanking.js";

/** 2026-09-10 00:00 Asia/Dhaka, in UTC milliseconds. Synthetic ids and names only. */
const DAY0 = Date.UTC(2026, 8, 9, 18, 0, 0);
const DAY_MS = 86_400_000;
const MIN = 60_000;
const at = (day: number, minute: number) => DAY0 + day * DAY_MS + minute * MIN;

const customer = (group: string, day: number, minute: number): ReportMessage => ({ groupKey: group, ts: at(day, minute), kind: "CUSTOMER", memberId: null });
const member = (group: string, day: number, minute: number, memberId: string): ReportMessage => ({ groupKey: group, ts: at(day, minute), kind: "MEMBER", memberId });

function options(days: number, overrides: Partial<TeamReportOptions> = {}): TeamReportOptions {
  return {
    rangeStart: DAY0,
    rangeEnd: DAY0 + days * DAY_MS,
    now: DAY0 + (days + 2) * DAY_MS,
    idleGapMs: 30 * MIN,
    missedAfterMs: () => 30 * MIN,
    assignedMemberFor: () => null,
    memberId: null,
    granularity: "day",
    ...overrides,
  };
}

function analyse(messages: ReportMessage[], days: number, overrides: Partial<TeamReportOptions> = {}) {
  const opts = options(days, overrides);
  const result = computeTeamReport(messages, opts);
  const scope = opts.scope ?? (opts.memberId ? (id: string) => id === opts.memberId : null);
  return { result, analytics: computeEmployeeAnalytics({ messages, result, rangeStart: opts.rangeStart, rangeEnd: opts.rangeEnd, scope }) };
}

describe("groups engaged is the members table's `groups`", () => {
  const messages: ReportMessage[] = [
    member("G1", 0, 540, "asha"),
    member("G2", 0, 550, "asha"),
    member("G1", 1, 540, "asha"),
    member("G3", 2, 540, "babul"),
    member("G1", 2, 560, "babul"),
    member("G1", 2, 570, "মৌসুমী"),
    customer("G9", 1, 100),
  ];

  it("for a one-day period, equals the row's groups for every member", () => {
    const { result, analytics } = analyse(messages, 1);
    for (const row of analytics.rows) {
      expect(row.groupsEngaged).toBe(result.members.find((m) => m.memberId === row.memberId)!.groups);
    }
    expect(analytics.rows.find((r) => r.memberId === "asha")!.groupsEngaged).toBe(2);
  });

  it("for a week, equals the row's groups for every member (a group worked on three days counts once)", () => {
    const { result, analytics } = analyse(messages, 7);
    for (const row of analytics.rows) {
      expect(row.groupsEngaged).toBe(result.members.find((m) => m.memberId === row.memberId)!.groups);
    }
    const asha = analytics.daily.members.find((m) => m.memberId === "asha")!;
    expect(asha.distinctGroups).toBe(2);
    expect(asha.sumOfDays).toBe(3); // G1 + G2 on day 0, G1 on day 1: the sum is NOT the distinct count
    expect(asha.activeDays).toBe(2);
    expect(asha.avgPerActiveDay).toBe(1.5);
  });

  it("with a member scope, equals the scoped row's groups", () => {
    const { result, analytics } = analyse(messages, 7, { memberId: "babul" });
    expect(analytics.rows.map((r) => r.memberId)).toEqual(["babul"]);
    expect(analytics.rows[0]!.groupsEngaged).toBe(result.members[0]!.groups);
    expect(analytics.daily.members.map((m) => m.memberId)).toEqual(["babul"]);
  });

  it("with a Team scope that changes mid-period, counts only the moments in scope (as computeTeamReport does)", () => {
    const scope = (id: string, ts: number) => id === "asha" && ts < at(1, 0);
    const { result, analytics } = analyse(messages, 7, { scope });
    const row = analytics.rows.find((r) => r.memberId === "asha")!;
    expect(row.groupsEngaged).toBe(result.members.find((m) => m.memberId === "asha")!.groups);
    expect(row.activeDays).toBe(1);
    expect(analytics.rows.some((r) => r.memberId === "babul")).toBe(false);
  });
});

describe("daily engagement totals", () => {
  it("a day's total is the distinct groups engaged by anyone, not the sum of the people", () => {
    const { analytics } = analyse([member("G1", 0, 540, "asha"), member("G1", 0, 545, "babul"), member("G2", 0, 550, "babul"), member("G1", 1, 540, "asha")], 3);
    expect(analytics.daily.dayTotals).toEqual([2, 1, 0]);
    expect(analytics.daily.distinctOverall).toBe(2);
    expect(analytics.daily.sumOfDayTotals).toBe(3);
    expect(analytics.days).toHaveLength(3);
  });

  it("a Dhaka day boundary decides the day (23:59 and 00:00 are different days)", () => {
    const { analytics } = analyse([member("G1", 0, 23 * 60 + 59, "asha"), member("G1", 1, 0, "asha")], 2);
    expect(analytics.daily.members[0]!.perDay).toEqual([1, 1]);
  });
});

describe("ranking", () => {
  // asha: 5 active days, 3 groups; babul: 5 days, 1 group; chitra: 2 active days (below the guard of 3)
  const messages: ReportMessage[] = [];
  for (let d = 0; d < 5; d++) {
    messages.push(member("G1", d, 540, "asha"), member("G2", d, 541, "asha"), member("G3", d, 542, "asha"));
    messages.push(member("G1", d, 600, "babul"));
  }
  messages.push(member("G1", 0, 700, "chitra"), member("G1", 1, 700, "chitra"));

  it("ranks each measure separately and guards a small sample: not ranked last, not ranked", () => {
    const { analytics } = analyse(messages, 7);
    const by = (id: string) => analytics.rows.find((r) => r.memberId === id)!;
    expect(by("asha").ranks.groupsEngaged).toMatchObject({ status: "RANKED", rank: 1 });
    expect(by("babul").ranks.groupsEngaged).toMatchObject({ status: "RANKED", rank: 2, of: 2 });
    // chitra worked 2 days of the 7: below the 3-day guard on every measure but the sample itself
    expect(by("chitra").ranks.groupsEngaged).toEqual({ status: "NOT_ENOUGH_DATA" });
    expect(by("chitra").ranks.replies).toEqual({ status: "NOT_ENOUGH_DATA" });
    expect(by("chitra").ranks.missed).toEqual({ status: "NOT_ENOUGH_DATA" });
    // active days is the sample itself: ranked for anybody who worked, so chitra is behind on it
    expect(by("chitra").ranks.activeDays).toMatchObject({ status: "RANKED", rank: 3 });
    // nobody has 5 closed waits: no response-time rank at all
    expect(by("asha").ranks.medianResponseSeconds).toEqual({ status: "NOT_ENOUGH_DATA" });
  });

  it("a one-day period asks only for the one day it has, so a day report is still ranked", () => {
    const { analytics } = analyse([member("G1", 0, 540, "asha"), member("G2", 0, 541, "asha"), member("G1", 0, 600, "babul")], 1);
    expect(analytics.minActiveDays).toBe(1);
    expect(analytics.rows.find((r) => r.memberId === "asha")!.ranks.groupsEngaged).toMatchObject({ status: "RANKED", rank: 1 });
  });

  it("ties share a rank and the next rank skips; fewer is better for missed", () => {
    const ranked = rankValues(
      [
        { id: "a", value: 5 },
        { id: "b", value: 5 },
        { id: "c", value: 2 },
      ],
      "higher",
    );
    expect([ranked.get("a")!.rank, ranked.get("b")!.rank, ranked.get("c")!.rank]).toEqual([1, 1, 3]);
    const missed = rankValues(
      [
        { id: "a", value: 4 },
        { id: "b", value: 0 },
        { id: "c", value: 0 },
        { id: "d", value: 9 },
      ],
      "lower",
    );
    expect([missed.get("b")!.rank, missed.get("c")!.rank, missed.get("a")!.rank, missed.get("d")!.rank]).toEqual([1, 1, 3, 4]);
  });

  it("highlights the top 3 and the bottom 3 of the ranked, nobody when there are too few or all are equal", () => {
    const seven = rankValues(
      ["a", "b", "c", "d", "e", "f", "g"].map((id, i) => ({ id, value: 100 - i })),
      "higher",
    );
    expect(["a", "b", "c", "d", "e", "f", "g"].map((id) => seven.get(id)!.highlight)).toEqual(["top", "top", "top", null, "behind", "behind", "behind"]);
    const three = rankValues(
      ["a", "b", "c"].map((id, i) => ({ id, value: 10 - i })),
      "higher",
    );
    expect(["a", "b", "c"].map((id) => three.get(id)!.highlight)).toEqual(["top", "top", "top"]);
    const equal = rankValues(["a", "b", "c", "d", "e"].map((id) => ({ id, value: 7 })), "higher");
    expect([...equal.values()].every((c) => c.highlight === null && c.rank === 1)).toBe(true);
    // a tie at the bottom shares "behind"
    const tied = rankValues(
      [
        { id: "a", value: 9 },
        { id: "b", value: 8 },
        { id: "c", value: 7 },
        { id: "d", value: 6 },
        { id: "e", value: 1 },
        { id: "f", value: 1 },
      ],
      "higher",
    );
    expect(tied.get("e")!.highlight).toBe("behind");
    expect(tied.get("f")!.highlight).toBe("behind");
    expect(tied.get("d")!.highlight).toBe("behind");
  });

  it(`the response median needs ${MIN_CLOSED_WAITS_FOR_MEDIAN} closed waits and is over the waits THEY closed`, () => {
    const msgs: ReportMessage[] = [];
    for (let d = 0; d < 3; d++) {
      // asha closes 2 waits a day (6 in all) in 5 and 15 minutes; babul closes 1 a day (3 in all)
      msgs.push(customer("G1", d, 100), member("G1", d, 105, "asha"));
      msgs.push(customer("G2", d, 200), member("G2", d, 215, "asha"));
      msgs.push(customer("G3", d, 300), member("G3", d, 301, "babul"));
    }
    const { analytics } = analyse(msgs, 3);
    const asha = analytics.rows.find((r) => r.memberId === "asha")!;
    const babul = analytics.rows.find((r) => r.memberId === "babul")!;
    expect(asha.closedWaits).toBe(6);
    expect(asha.medianResponseSeconds).toBe(10 * 60); // median of six values 5,5,5,15,15,15 minutes
    expect(asha.ranks.medianResponseSeconds).toMatchObject({ status: "RANKED", rank: 1, of: 1 });
    expect(babul.closedWaits).toBe(3);
    expect(babul.ranks.medianResponseSeconds).toEqual({ status: "NOT_ENOUGH_DATA" });
  });

  it("a scoped report counts only the waits the member closed while in scope", () => {
    const msgs: ReportMessage[] = [customer("G1", 0, 100), member("G1", 0, 105, "asha"), customer("G1", 2, 100), member("G1", 2, 110, "asha")];
    const scope = (id: string, ts: number) => id === "asha" && ts < at(1, 0);
    const { analytics } = analyse(msgs, 3, { scope });
    expect(analytics.rows.find((r) => r.memberId === "asha")!.closedWaits).toBe(1);
  });

  it("missed is the members table's missed, and the Unassigned row is never ranked", () => {
    const { result, analytics } = analyse([customer("G1", 0, 100), member("G1", 0, 500, "asha")], 1, { assignedMemberFor: () => "asha" });
    expect(analytics.rows.find((r) => r.memberId === "asha")!.missed).toBe(result.members.find((m) => m.memberId === "asha")!.missed);
    const unassigned = analyse([customer("G1", 0, 100)], 1, { now: at(0, 1000) });
    expect(unassigned.analytics.rows.map((r) => r.memberId)).not.toContain("UNASSIGNED");
  });
});

describe("period comparison", () => {
  it("the previous period is the equal-length period just before", () => {
    expect(previousPeriod(DAY0 + 7 * DAY_MS, DAY0 + 14 * DAY_MS)).toEqual({ start: DAY0, end: DAY0 + 7 * DAY_MS, days: 7, partial: false });
    // A finished period is unchanged by `now`.
    expect(previousPeriod(DAY0 + 7 * DAY_MS, DAY0 + 14 * DAY_MS, DAY0 + 20 * DAY_MS)).toEqual({ start: DAY0, end: DAY0 + 7 * DAY_MS, days: 7, partial: false });
  });

  it("a period still running is compared with as many whole days just before it (review fix)", () => {
    // A 31-day month viewed during its 20th day: 20 days now, the 20 days just before, never 31.
    const start = DAY0 + 40 * DAY_MS;
    const prev = previousPeriod(start, start + 31 * DAY_MS, start + 19 * DAY_MS + 3_600_000);
    expect(prev).toEqual({ start: start - 20 * DAY_MS, end: start, days: 20, partial: true });
    // The first hour of a day period: one day before it.
    expect(previousPeriod(start, start + DAY_MS, start + 1)).toEqual({ start: start - DAY_MS, end: start, days: 1, partial: true });
  });

  it("shows then, now and the change; a member absent from one period has 0 in it", () => {
    const then = analyse([member("G1", 0, 540, "asha"), member("G2", 1, 540, "asha")], 7).analytics;
    const now = analyse([member("G1", 0, 540, "asha"), member("G1", 1, 540, "babul")], 7).analytics;
    const rows = compareEmployeePeriods(now, then);
    const asha = rows.find((r) => r.memberId === "asha")!;
    expect(asha.figures.groupsEngaged).toEqual({ then: 2, now: 1, change: -1 });
    expect(asha.figures.replies).toEqual({ then: 2, now: 1, change: -1 });
    const babul = rows.find((r) => r.memberId === "babul")!;
    expect(babul.figures.groupsEngaged).toEqual({ then: 0, now: 1, change: 1 });
  });
});
