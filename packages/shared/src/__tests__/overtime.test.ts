import { describe, expect, it } from "vitest";
import {
  clampFallbackMinutes,
  computeOvertimeDays,
  resolveRegularDuty,
  shiftLengthMinutes,
  type DutyDayEvidence,
  type ResolvedDuty,
} from "../overtime.js";
import { computeTeamReport, type ReportMessage, type TeamReportOptions } from "../teamReport.js";

/**
 * Support Overtime (TEAM_OVERTIME.md): time worked beyond regular duty, per Dhaka day, summed.
 * Each case below is one the old figure got wrong — it reported ALL support time as "overtime".
 */

const H = 3_600_000;
const M = 60_000;
/** A Dhaka wall-clock instant on 2026-10-0<d>. */
const at = (d: number, hh: number, mm = 0) => Date.UTC(2026, 9, d, hh - 6, mm);
const day = (d: number) => `2026-10-${String(d).padStart(2, "0")}`;

const NONE: DutyDayEvidence = { assignment: null, isHoliday: false, pattern: null, defaultShift: null, fallbackMinutes: 480 };
const duty = (hours: number): ResolvedDuty => ({ regularSeconds: hours * 3600, startMinute: null, endMinute: null, source: "FALLBACK" });

/** One continuous stretch of work [start, end). */
const work = (start: number, end: number) => ({ start, end });
const overtimeOf = (stretches: Array<{ start: number; end: number }>, dutyFor: (memberId: string, day: string) => ResolvedDuty) =>
  computeOvertimeDays(new Map([["m1", stretches]]), dutyFor);

describe("daily overtime = max(0, worked − regular duty)", () => {
  it.each([
    [8, 6, 0],
    [8, 8, 0],
    [8, 7, 0],
    [8, 10, 2],
    [8, 12, 4],
    [9, 9, 0],
    [9, 11, 2],
    [9, 12, 3],
  ])("%ih duty, %ih worked → %ih overtime", (dutyHours, workedHours, expected) => {
    const rows = overtimeOf([work(at(5, 9), at(5, 9) + workedHours * H)], () => duty(dutyHours));
    expect(rows).toEqual([{ memberId: "m1", day: day(5), overtimeSeconds: expected * 3600, source: "FALLBACK" }]);
  });
});

describe("each day on its own, then summed", () => {
  it("never nets one day's short hours against another day's long ones", () => {
    // Mon 10h, Tue 6h with 8h duty: 2h overtime, not (16 − 16) = 0.
    const rows = overtimeOf([work(at(5, 9), at(5, 19)), work(at(6, 9), at(6, 15))], () => duty(8));
    expect(rows.map((r) => r.overtimeSeconds)).toEqual([2 * 3600, 0]);
  });

  it("counts a day off, leave or holiday entirely as overtime", () => {
    const rows = overtimeOf([work(at(5, 10), at(5, 13))], () => resolveRegularDuty({ ...NONE, assignment: { status: "OFF", startMinute: null, endMinute: null } }));
    expect(rows[0]).toMatchObject({ overtimeSeconds: 3 * 3600, source: "NO_DUTY" });
  });
});

describe("overnight shifts", () => {
  it("counts after-midnight work inside a 22:00–06:00 shift for the evening it began", () => {
    const night = resolveRegularDuty({ ...NONE, assignment: { status: "DUTY", startMinute: 22 * 60, endMinute: 6 * 60 } });
    const off = resolveRegularDuty({ ...NONE, assignment: { status: "OFF", startMinute: null, endMinute: null } });
    const dutyFor = (_m: string, d: string) => (d === day(5) ? night : off);
    // 22:00–24:00 on the 5th and 00:00–07:00 on the 6th (stretches split at midnight).
    const rows = overtimeOf([work(at(5, 22), at(6, 0) - 1000), work(at(6, 0), at(6, 7))], dutyFor);
    const byDay = Object.fromEntries(rows.map((r) => [r.day, r.overtimeSeconds]));
    // The shift (8h) holds 22:00–06:00 ≈ 8h → 0 overtime that evening; 06:00–07:00 is the 6th, an off day.
    expect(byDay[day(5)]).toBe(0);
    expect(byDay[day(6)]).toBe(3600);
  });
});

describe("resolveRegularDuty — which duty applies", () => {
  it("prefers the roster's own shift snapshot", () => {
    expect(resolveRegularDuty({ ...NONE, assignment: { status: "DUTY", startMinute: 600, endMinute: 1140 }, defaultShift: { startMinute: 0, endMinute: 60 } })).toMatchObject({
      regularSeconds: 9 * 3600,
      source: "ROSTER",
    });
  });

  it("gives no regular duty for off, leave, holiday and extra duty", () => {
    for (const status of ["OFF", "LEAVE", "HOLIDAY", "EXTRA_DUTY"]) {
      expect(resolveRegularDuty({ ...NONE, assignment: { status, startMinute: 600, endMinute: 1140 } })).toMatchObject({ regularSeconds: 0, source: "NO_DUTY" });
    }
  });

  it("reads UNASSIGNED as no roster decision", () => {
    expect(resolveRegularDuty({ ...NONE, assignment: { status: "UNASSIGNED", startMinute: null, endMinute: null }, pattern: { startMinute: 720, endMinute: 1260 } })).toMatchObject({
      regularSeconds: 9 * 3600,
      source: "WEEKLY_PATTERN",
    });
  });

  it("treats an organisation holiday as no duty only when the roster has not decided the day", () => {
    expect(resolveRegularDuty({ ...NONE, isHoliday: true, pattern: { startMinute: 600, endMinute: 1140 } }).source).toBe("NO_DUTY");
    // Rostered on duty, without times, on a holiday: still a working day.
    expect(resolveRegularDuty({ ...NONE, isHoliday: true, assignment: { status: "DUTY", startMinute: null, endMinute: null } })).toMatchObject({
      regularSeconds: 8 * 3600,
      source: "FALLBACK",
    });
  });

  it("then the weekly pattern (an entry with no shift is a decided day off), then the default shift", () => {
    expect(resolveRegularDuty({ ...NONE, pattern: "OFF", defaultShift: { startMinute: 600, endMinute: 1140 } }).source).toBe("NO_DUTY");
    expect(resolveRegularDuty({ ...NONE, defaultShift: { startMinute: 780, endMinute: 1320 } })).toMatchObject({ regularSeconds: 9 * 3600, source: "DEFAULT_SHIFT" });
  });

  it("falls back to the configured default duty length when nothing is known", () => {
    expect(resolveRegularDuty(NONE)).toMatchObject({ regularSeconds: 8 * 3600, source: "FALLBACK" });
    expect(resolveRegularDuty({ ...NONE, fallbackMinutes: 540 }).regularSeconds).toBe(9 * 3600);
    expect(clampFallbackMinutes(Number.NaN)).toBe(480);
    expect(clampFallbackMinutes(5)).toBe(60);
    expect(clampFallbackMinutes(24 * 60)).toBe(16 * 60);
  });

  it("measures a shift by its configured times, past midnight included", () => {
    expect(shiftLengthMinutes(600, 1140)).toBe(540);
    expect(shiftLengthMinutes(22 * 60, 6 * 60)).toBe(480);
  });
});

describe("through the Team Report", () => {
  const base: TeamReportOptions = {
    rangeStart: at(5, 0),
    rangeEnd: at(8, 0),
    now: at(9, 0),
    idleGapMs: 2 * H,
    missedAfterMs: () => 30 * M,
    assignedMemberFor: () => null,
    memberId: null,
    granularity: "day",
  };
  /** A member message every 30 minutes from `from` to `to` (inclusive), in one group or two. */
  const every30 = (memberId: string, from: number, to: number, groups = ["g1"]): ReportMessage[] => {
    const out: ReportMessage[] = [];
    let i = 0;
    for (let ts = from; ts <= to; ts += 30 * M) out.push({ groupKey: groups[i++ % groups.length]!, ts, kind: "MEMBER", memberId });
    return out;
  };

  it("shows overtime only — 10h worked on an 8h default is 2h, not 10h", () => {
    const result = computeTeamReport(every30("m1", at(5, 9), at(5, 19)), base);
    expect(result.members[0]).toMatchObject({ memberId: "m1", activeSeconds: 10 * 3600, overtimeSeconds: 2 * 3600, unscheduledDays: 1 });
    expect(result.summary).toMatchObject({ overtimeSeconds: 2 * 3600, unscheduledMemberDays: 1 });
    expect(result.buckets.find((b) => b.key === day(5))?.overtimeSeconds).toBe(2 * 3600);
  });

  it("does not double-count two groups worked at the same time", () => {
    const result = computeTeamReport(every30("m1", at(5, 9), at(5, 19), ["g1", "g2"]), base);
    expect(result.summary.overtimeSeconds).toBe(2 * 3600);
  });

  it("does not inflate overtime with duplicate events", () => {
    const messages = every30("m1", at(5, 9), at(5, 19));
    const result = computeTeamReport([...messages, ...messages], base);
    expect(result.summary.overtimeSeconds).toBe(2 * 3600);
  });

  it("does not turn two messages twelve hours apart into twelve hours of work", () => {
    const messages: ReportMessage[] = [
      { groupKey: "g1", ts: at(5, 10), kind: "MEMBER", memberId: "m1" },
      { groupKey: "g1", ts: at(5, 22), kind: "MEMBER", memberId: "m1" },
    ];
    expect(computeTeamReport(messages, base).summary.overtimeSeconds).toBe(0);
  });

  it("uses each member's own duty, per day", () => {
    const dutyFor = (memberId: string) => (memberId === "m2" ? duty(9) : duty(8));
    const result = computeTeamReport([...every30("m1", at(5, 9), at(5, 20)), ...every30("m2", at(5, 9), at(5, 20))], { ...base, dutyFor });
    const ot = Object.fromEntries(result.members.map((m) => [m.memberId, m.overtimeSeconds]));
    expect(ot).toEqual({ m1: 3 * 3600, m2: 2 * 3600 });
    // Table, buckets, summary and the per-day breakdown agree.
    expect(result.summary.overtimeSeconds).toBe(5 * 3600);
    expect(result.buckets.reduce((s, b) => s + b.overtimeSeconds, 0)).toBe(5 * 3600);
    expect(result.overtimeDays.reduce((s, d) => s + d.overtimeSeconds, 0)).toBe(5 * 3600);
  });

  it("uses the schedule effective on each date (a historical roster snapshot)", () => {
    // Day 5 was a 9h shift, day 6 an 8h one; 10h each day.
    const dutyFor = (_m: string, d: string) => resolveRegularDuty({ ...NONE, assignment: { status: "DUTY", startMinute: 540, endMinute: d === day(5) ? 1080 : 1020 } });
    const result = computeTeamReport([...every30("m1", at(5, 9), at(5, 19)), ...every30("m1", at(6, 9), at(6, 19))], { ...base, dutyFor });
    expect(result.overtimeDays.map((d) => d.overtimeSeconds)).toEqual([3600, 2 * 3600]);
  });

  it("scopes overtime to the in-scope member", () => {
    const result = computeTeamReport([...every30("m1", at(5, 9), at(5, 19)), ...every30("m2", at(5, 9), at(5, 21))], { ...base, memberId: "m2" });
    expect(result.summary.overtimeSeconds).toBe(4 * 3600);
  });

  it("reports a day with no work as no overtime row at all — not a confirmed zero", () => {
    const result = computeTeamReport(every30("m1", at(5, 9), at(5, 19)), base);
    expect(result.overtimeDays.map((d) => d.day)).toEqual([day(5)]);
    expect(result.buckets.find((b) => b.key === day(6))).toMatchObject({ overtimeSeconds: 0, memberMessages: 0 });
  });
});
