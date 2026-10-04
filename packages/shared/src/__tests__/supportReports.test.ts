import { describe, expect, it } from "vitest";
import { computeTeamReport, type ReportMessage, type ReportWait, type TeamReportOptions } from "../teamReport.js";
import {
  activityHeatmap,
  classifyGroupActivity,
  daysBetween,
  detectCallMention,
  dhakaWeekdayHour,
  distributionValue,
  dutyWorkload,
  groupActivityTrend,
  groupMessageCounts,
  median,
  memberGroupBreakdown,
  memberTimelines,
  outcomeOf,
  percentile,
  responseStats,
  sharesOf,
  shiftWindow,
  teamWorkload,
} from "../supportReports.js";
import { datePresetParams, GENERIC_REPORT_IDS, REPORT_CATALOGUE, REPORT_CATEGORIES } from "../reportCatalogue.js";

/** 2026-09-10 00:00 Asia/Dhaka (a Thursday), in UTC milliseconds. */
const DAY = Date.UTC(2026, 8, 9, 18, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (minutesAfterDhakaMidnight: number) => DAY + minutesAfterDhakaMidnight * MIN;

const customer = (group: string, minute: number): ReportMessage => ({ groupKey: group, ts: at(minute), kind: "CUSTOMER", memberId: null });
const member = (group: string, minute: number, memberId: string): ReportMessage => ({ groupKey: group, ts: at(minute), kind: "MEMBER", memberId });
const business = (group: string, minute: number): ReportMessage => ({ groupKey: group, ts: at(minute), kind: "BUSINESS", memberId: null });

const RANGE = { rangeStart: DAY, rangeEnd: DAY + 86_400_000 };

function report(messages: ReportMessage[], overrides: Partial<TeamReportOptions> = {}) {
  return computeTeamReport(messages, {
    ...RANGE,
    now: DAY + 86_400_000,
    idleGapMs: 30 * MIN,
    missedAfterMs: () => 30 * MIN,
    assignedMemberFor: () => null,
    memberId: null,
    granularity: "day",
    ...overrides,
  });
}

const wait = (status: ReportWait["status"], waitMinutes: number | null, extra: Partial<ReportWait> = {}): ReportWait => ({
  groupKey: "A",
  askedAt: at(600),
  repliedAt: waitMinutes === null ? null : at(600 + waitMinutes),
  repliedBy: waitMinutes === null ? null : "rudra",
  waitSeconds: waitMinutes === null ? null : waitMinutes * 60,
  thresholdSeconds: 1800,
  status,
  ...extra,
});

describe("response statistics", () => {
  it("SLA % = within ÷ (within + late + never); pending waits are left out", () => {
    const stats = responseStats([wait("ON_TIME", 5), wait("ON_TIME", 10), wait("RECALLED", 45), wait("MISSED", null), wait("PENDING", null)]);
    expect(stats).toMatchObject({ waits: 5, within: 2, late: 1, never: 1, pending: 1, answered: 3 });
    expect(stats.slaRatio).toBeCloseTo(2 / 4);
    expect(stats.coverageRatio).toBeCloseTo(3 / 4);
  });

  it("response times are over answered waits only: median, average, p90, worst", () => {
    const stats = responseStats([wait("ON_TIME", 1), wait("ON_TIME", 2), wait("RECALLED", 60), wait("MISSED", null)]);
    expect(stats.medianSeconds).toBe(120);
    expect(stats.averageSeconds).toBe(Math.round((60 + 120 + 3600) / 3));
    expect(stats.p90Seconds).toBe(3600);
    expect(stats.maxSeconds).toBe(3600);
  });

  it("nothing decided means no percentage, not 0% or 100%", () => {
    expect(responseStats([wait("PENDING", null)])).toMatchObject({ slaRatio: null, coverageRatio: null, medianSeconds: null });
    expect(responseStats([])).toMatchObject({ waits: 0, slaRatio: null });
  });

  it("median and percentile helpers", () => {
    expect(median([1, 2, 3, 4])).toBe(3); // (2+3)/2 rounded
    expect(median([5])).toBe(5);
    expect(median([])).toBeNull();
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
  });

  it("maps every wait status to exactly one Missed Support outcome", () => {
    expect(["ON_TIME", "RECALLED", "MISSED", "PENDING"].map((s) => outcomeOf(wait(s as ReportWait["status"], 1)))).toEqual([
      "ANSWERED",
      "ANSWERED_LATE",
      "NEVER_ANSWERED",
      "WAITING",
    ]);
  });

  it("uses computeTeamReport's own waits: the figures agree with the Team Report", () => {
    const r = report([customer("A", 540), member("A", 545, "rudra"), customer("B", 540), member("B", 640, "rudra"), customer("C", 100)]);
    const stats = responseStats(r.waits);
    expect(stats.within).toBe(r.waits.filter((w) => w.status === "ON_TIME").length);
    expect(stats.late + stats.never).toBe(r.summary.missed);
    expect(stats.late).toBe(r.summary.recalled);
    expect(stats.never).toBe(r.summary.unrecovered);
  });
});

describe("inactive groups", () => {
  it("separates no communication, no customer activity, customer activity with no reply, low activity and active", () => {
    const messages = [
      member("ANNOUNCE", 60, "rudra"), // team posted, no customer
      customer("SILENT_REPLY", 60),
      customer("SILENT_REPLY", 61),
      customer("LOW", 60),
      member("LOW", 62, "rudra"),
      ...Array.from({ length: 6 }, (_, i) => (i % 2 ? member("BUSY", 60 + i, "rudra") : customer("BUSY", 60 + i))),
      business("BIZ", 70),
      customer("BIZ", 71),
      business("BIZ", 72),
      customer("BIZ", 73),
      business("BIZ", 74),
    ];
    const counts = groupMessageCounts(messages, RANGE.rangeStart, RANGE.rangeEnd);
    // Not one message of any kind: no communication — never confused with "no customer message".
    expect(classifyGroupActivity(counts.get("NOTHING"), 5)).toBe("NO_COMMUNICATION");
    expect(classifyGroupActivity(undefined, 5)).toBe("NO_COMMUNICATION");
    // Only the team posted: that IS communication.
    expect(classifyGroupActivity(counts.get("ANNOUNCE"), 5)).toBe("NO_CUSTOMER_ACTIVITY");
    expect(classifyGroupActivity(counts.get("SILENT_REPLY"), 5)).toBe("CUSTOMER_NO_REPLY");
    expect(classifyGroupActivity(counts.get("LOW"), 5)).toBe("LOW_ACTIVITY");
    expect(classifyGroupActivity(counts.get("BUSY"), 5)).toBe("ACTIVE");
    // A business-number reply is a reply.
    expect(classifyGroupActivity(counts.get("BIZ"), 5)).toBe("ACTIVE");
    // The threshold is the caller's.
    expect(classifyGroupActivity(counts.get("BUSY"), 10)).toBe("LOW_ACTIVITY");
  });

  it("a group with only customer messages had communication, even unanswered", () => {
    const counts = groupMessageCounts([customer("C", 10), customer("C", 11)], RANGE.rangeStart, RANGE.rangeEnd);
    expect(classifyGroupActivity(counts.get("C"), 5)).toBe("CUSTOMER_NO_REPLY");
  });

  it("a group busy before the period and silent in it has no communication in the period", () => {
    const counts = groupMessageCounts([customer("BEFORE", -100), member("BEFORE", -90, "rudra")], RANGE.rangeStart, RANGE.rangeEnd);
    expect(counts.get("BEFORE")).toBeUndefined();
    expect(classifyGroupActivity(counts.get("BEFORE"), 5)).toBe("NO_COMMUNICATION");
  });

  it("only counts messages inside the period", () => {
    const counts = groupMessageCounts([customer("A", -10), customer("A", 10)], RANGE.rangeStart, RANGE.rangeEnd);
    expect(counts.get("A")).toMatchObject({ customer: 1, total: 1, lastAt: at(10) });
  });

  it("days since last message: whole days, null when there was none", () => {
    expect(daysBetween(at(0), at(0) + 3.9 * 86_400_000)).toBe(3);
    expect(daysBetween(null, at(0))).toBeNull();
  });
});

describe("team workload", () => {
  it("support time equals the Team Report's for every member, so the reports cannot disagree", () => {
    const messages = [
      member("A", 600, "rudra"),
      member("B", 610, "rudra"), // parallel groups: one timeline
      member("A", 620, "rudra"),
      member("A", 900, "bipul"),
      member("A", 930, "bipul"),
      member("A", 1300, "bipul"), // after the idle gap: new stretch
    ];
    const r = report(messages);
    const rows = teamWorkload(messages, r.waits, { ...RANGE, idleGapMs: 30 * MIN, inScope: null });
    for (const row of rows) {
      expect(row.activeSeconds).toBe(r.members.find((m) => m.memberId === row.memberId)!.activeSeconds);
    }
    expect(rows.find((x) => x.memberId === "rudra")).toMatchObject({ replies: 3, groups: 2, activeSeconds: 20 * 60, stretches: 1, activeDays: 1 });
    expect(rows.find((x) => x.memberId === "bipul")).toMatchObject({ stretches: 2, activeSeconds: 30 * 60 });
  });

  it("overlapping work in two groups is counted once, never twice", () => {
    const messages = [member("A", 600, "rudra"), member("B", 605, "rudra"), member("A", 630, "rudra"), member("B", 660, "rudra")];
    const rows = teamWorkload(messages, [], { ...RANGE, idleGapMs: 60 * MIN, inScope: null });
    expect(rows[0]!.activeSeconds).toBe(60 * 60);
  });

  it("waits answered are the waits that member's reply closed, and respect the scope", () => {
    const messages = [customer("A", 600), member("A", 605, "rudra"), customer("A", 700), member("A", 720, "bipul")];
    const r = report(messages);
    const all = teamWorkload(messages, r.waits, { ...RANGE, idleGapMs: 30 * MIN, inScope: null });
    expect(all.find((x) => x.memberId === "rudra")!.waitsAnswered).toBe(1);
    const onlyRudra = teamWorkload(messages, r.waits, { ...RANGE, idleGapMs: 30 * MIN, inScope: (id) => id === "rudra" });
    expect(onlyRudra.map((x) => x.memberId)).toEqual(["rudra"]);
  });

  it("a member whose only reply fell in the look-ahead still answered that wait", () => {
    // Asked at 23:50 on the last day, answered at 00:10 the next morning by somebody who sent
    // nothing inside the period.
    const messages = [customer("A", 23 * 60 + 50), member("A", 24 * 60 + 10, "night")];
    const r = report(messages);
    const rows = teamWorkload(messages, r.waits, { ...RANGE, idleGapMs: 30 * MIN, inScope: null });
    expect(rows).toEqual([expect.objectContaining({ memberId: "night", replies: 0, waitsAnswered: 1, activeSeconds: 0 })]);
    expect(rows.reduce((sum, row) => sum + row.waitsAnswered, 0)).toBe(r.waits.filter((w) => w.repliedBy === "night").length);
  });

  it("a scope that changes mid-day counts only the in-scope part", () => {
    const messages = [member("A", 600, "rudra"), member("A", 610, "rudra"), member("A", 620, "rudra")];
    const timelines = memberTimelines(messages, { ...RANGE, inScope: (_id, ts) => ts < at(615) });
    expect(timelines.get("rudra")).toEqual([at(600), at(610)]);
  });

  it("distribution shares add up to the printed total", () => {
    const rows = teamWorkload(
      [member("A", 600, "rudra"), member("A", 601, "rudra"), member("A", 602, "rudra"), member("B", 600, "bipul")],
      [],
      { ...RANGE, idleGapMs: 30 * MIN, inScope: null },
    );
    const { rows: shares, total } = sharesOf(rows, (row) => distributionValue(row, "replies"));
    expect(total).toBe(4);
    expect(shares.map((s) => [s.item.memberId, s.share])).toEqual([
      ["rudra", 0.75],
      ["bipul", 0.25],
    ]);
    expect(sharesOf(rows, () => 0).rows.every((s) => s.share === null)).toBe(true);
  });
});

describe("employee × group breakdown", () => {
  it("one row per member per group; per-group time can add up to more than the person's own total", () => {
    const messages = [
      customer("A", 590),
      member("A", 600, "rudra"),
      member("B", 605, "rudra"),
      member("A", 630, "rudra"),
      member("B", 640, "rudra"),
      customer("B", 650),
      member("B", 660, "rudra"),
    ];
    const r = report(messages);
    const rows = memberGroupBreakdown(messages, r.waits, { ...RANGE, idleGapMs: 60 * MIN, inScope: null });
    const a = rows.find((x) => x.groupKey === "A")!;
    const b = rows.find((x) => x.groupKey === "B")!;
    expect(a).toMatchObject({ replies: 2, customerMessages: 1, waitsAnswered: 1, medianResponseSeconds: 600, activeSeconds: 30 * 60 });
    expect(b).toMatchObject({ replies: 3, customerMessages: 1, waitsAnswered: 1, medianResponseSeconds: 600, activeSeconds: 55 * 60 });
    const own = r.members.find((m) => m.memberId === "rudra")!.activeSeconds;
    expect(own).toBe(60 * 60);
    expect(a.activeSeconds + b.activeSeconds).toBeGreaterThan(own);
  });
});

describe("heatmap", () => {
  it("buckets by Dhaka weekday and hour, not UTC", () => {
    // 2026-09-10 00:30 Dhaka is 2026-09-09 18:30 UTC — Thursday 00h in Dhaka, Wednesday 18h in UTC.
    expect(dhakaWeekdayHour(at(30))).toEqual({ weekday: 4, hour: 0 });
    const grid = activityHeatmap([customer("A", 30), customer("A", 40), member("A", 50, "rudra"), business("A", 55)], [], "customer", RANGE);
    expect(grid[4]![0]).toBe(2);
    expect(grid.flat().reduce((a, b) => a + b, 0)).toBe(2);
    const replies = activityHeatmap([customer("A", 30), member("A", 50, "rudra"), business("A", 55)], [], "replies", RANGE);
    expect(replies[4]![0]).toBe(2);
  });

  it("the waits metric counts the hour each wait started", () => {
    const r = report([customer("A", 600), customer("A", 601), member("A", 610, "rudra")]);
    const grid = activityHeatmap([], r.waits, "waits", RANGE);
    expect(grid[4]![10]).toBe(1);
  });
});

describe("group activity trend", () => {
  it("per bucket: messages, replies, active groups and groups whose customers got no reply", () => {
    const messages = [customer("A", 60), member("A", 70, "rudra"), customer("B", 80), customer("C", 24 * 60 + 60)];
    const r = report(messages, { rangeEnd: DAY + 2 * 86_400_000, now: DAY + 2 * 86_400_000 });
    const rows = groupActivityTrend(messages, r.waits, { rangeStart: DAY, rangeEnd: DAY + 2 * 86_400_000, granularity: "day" });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ customerMessages: 2, replies: 1, activeGroups: 2, unansweredGroups: 1, waits: 2, missed: 1 });
    expect(rows[1]).toMatchObject({ customerMessages: 1, replies: 0, activeGroups: 1, unansweredGroups: 1, waits: 1 });
  });
});

describe("duty & workload", () => {
  const DATE = "2026-09-10";
  const NEXT = "2026-09-11";

  it("a shift ending at or before its start runs past midnight", () => {
    const w = shiftWindow(DATE, 22 * 60, 6 * 60);
    expect(w.start).toBe(at(22 * 60));
    expect(w.end).toBe(at(30 * 60));
  });

  it("time inside an overnight shift belongs to the day the shift started", () => {
    // Bipul works 22:00–06:00 on the 10th. Messages 23:00–23:50 on the 10th and 01:00–02:00 on the 11th.
    const ts = [at(23 * 60), at(23 * 60 + 50), at(25 * 60), at(26 * 60)];
    const rows = dutyWorkload(
      new Map([["bipul", ts]]),
      [{ memberId: "bipul", dutyDate: DATE, status: "DUTY", shiftName: "Night", startMinute: 22 * 60, endMinute: 6 * 60 }],
      { idleGapMs: 2 * HOUR },
    );
    const tenth = rows.find((r) => r.day === DATE)!;
    expect(tenth).toMatchObject({ scheduledSeconds: 8 * 3600, inShiftSeconds: 50 * 60 + 60 * 60, outsideShiftSeconds: 0 });
    // The 11th gets a row for the messages it holds, but none of the in-shift time.
    const eleventh = rows.find((r) => r.day === NEXT)!;
    expect(eleventh).toMatchObject({ inShiftSeconds: 0, outsideShiftSeconds: 0, messages: 2 });
    expect(tenth.unrecordedScheduledSeconds).toBe(8 * 3600 - 110 * 60);
  });

  it("splits a stretch into in-shift and beyond-schedule time, and off-day time on a day without a shift", () => {
    // Day shift 10:00–19:00. Messages 18:30–19:30 (half beyond), and on the 11th (OFF) 11:00–11:20.
    const ts = [at(18 * 60 + 30), at(19 * 60 + 30), at(24 * 60 + 11 * 60), at(24 * 60 + 11 * 60 + 20)];
    const rows = dutyWorkload(
      new Map([["rudra", ts]]),
      [
        { memberId: "rudra", dutyDate: DATE, status: "DUTY", shiftName: "Day", startMinute: 600, endMinute: 1140 },
        { memberId: "rudra", dutyDate: NEXT, status: "OFF", shiftName: null, startMinute: null, endMinute: null },
      ],
      { idleGapMs: 2 * HOUR },
    );
    expect(rows.find((r) => r.day === DATE)).toMatchObject({ inShiftSeconds: 1800, beyondScheduleSeconds: 1800, offDaySeconds: 0 });
    expect(rows.find((r) => r.day === NEXT)).toMatchObject({ status: "OFF", scheduledSeconds: 0, offDaySeconds: 1200, beyondScheduleSeconds: 0 });
  });

  it("in shift + outside shift equals the Team Report's support time, whatever the schedule", () => {
    const messages = [
      member("A", 300, "rudra"),
      member("B", 320, "rudra"),
      member("A", 610, "rudra"),
      member("A", 700, "rudra"),
      member("B", 1150, "rudra"),
      member("A", 1180, "rudra"),
      member("A", 1420, "rudra"),
    ];
    const r = report(messages, { idleGapMs: 60 * MIN });
    const timelines = memberTimelines(messages, { ...RANGE, inScope: null });
    for (const duties of [
      [],
      [{ memberId: "rudra", dutyDate: DATE, status: "DUTY", shiftName: "Day", startMinute: 600, endMinute: 1140 }],
      [{ memberId: "rudra", dutyDate: "2026-09-09", status: "DUTY", shiftName: "Night", startMinute: 22 * 60, endMinute: 6 * 60 }],
      [
        { memberId: "rudra", dutyDate: DATE, status: "DUTY", shiftName: "Early", startMinute: 300, endMinute: 700 },
        { memberId: "rudra", dutyDate: DATE, status: "EXTRA_DUTY", shiftName: "Late", startMinute: 650, endMinute: 1200 },
      ],
    ]) {
      const rows = dutyWorkload(timelines, duties, { idleGapMs: 60 * MIN });
      const recorded = rows.reduce((sum, row) => sum + row.inShiftSeconds + row.outsideShiftSeconds, 0);
      expect(recorded).toBe(r.members[0]!.activeSeconds);
    }
  });

  it("schedules only the part of a shift inside the period: an overnight shift is never counted twice", () => {
    const night = [{ memberId: "bipul", dutyDate: DATE, status: "DUTY", shiftName: "Night", startMinute: 22 * 60, endMinute: 6 * 60 }];
    const dayOf = (offset: number) => ({ periodStart: at(offset * 24 * 60), periodEnd: at((offset + 1) * 24 * 60) });
    const onItsDay = dutyWorkload(new Map(), night, { idleGapMs: HOUR, ...dayOf(0) });
    const nextDay = dutyWorkload(new Map(), night, { idleGapMs: HOUR, ...dayOf(1) });
    expect(onItsDay[0]!.scheduledSeconds).toBe(2 * 3600);
    expect(nextDay[0]!.scheduledSeconds).toBe(6 * 3600);
    expect(onItsDay[0]!.unrecordedScheduledSeconds + nextDay[0]!.unrecordedScheduledSeconds).toBe(8 * 3600);
    // A period covering both days sees the whole shift once.
    expect(dutyWorkload(new Map(), night, { idleGapMs: HOUR, periodStart: at(0), periodEnd: at(48 * 60) })[0]!.scheduledSeconds).toBe(8 * 3600);
  });

  it("leave and off days are never scheduled time", () => {
    const rows = dutyWorkload(new Map(), [{ memberId: "x", dutyDate: DATE, status: "LEAVE", shiftName: "Day", startMinute: 600, endMinute: 1140 }], {
      idleGapMs: HOUR,
    });
    expect(rows[0]).toMatchObject({ status: "LEAVE", scheduledSeconds: 0, unrecordedScheduledSeconds: 0 });
  });
});

describe("call activity (inferred from text)", () => {
  it("recognises requests, missed calls and mentions in English, Banglish and Bangla", () => {
    expect(detectCallMention("Please call me")?.kind).toBe("CALL_REQUESTED");
    expect(detectCallMention("vai ekta call den")?.kind).toBe("CALL_REQUESTED");
    expect(detectCallMention("আমাকে একটু কল দিন")?.kind).toBe("CALL_REQUESTED");
    expect(detectCallMention("ফোন করুন প্লিজ")?.kind).toBe("CALL_REQUESTED");
    expect(detectCallMention("I got a missed call from you")?.kind).toBe("MISSED_CALL");
    expect(detectCallMention("call dhorlen na keno")?.kind).toBe("MISSED_CALL");
    expect(detectCallMention("আপনারা কল ধরেন না")?.kind).toBe("MISSED_CALL");
    expect(detectCallMention("ami call dicchi")?.kind).toBe("CALL_MENTIONED");
    expect(detectCallMention("I called you twice")?.kind).toBe("CALL_MENTIONED");
    expect(detectCallMention("কল দিয়েছি, দেখুন")?.kind).toBe("CALL_MENTIONED");
  });

  it("does not see a call in ordinary support text", () => {
    for (const text of [
      "What is this module called?",
      "সকলে বিল দিয়েছে",
      // "সকল" is "all": its last two letters spell "কল" ("call").
      "সকল ধরনের সমস্যা সমাধান করা হবে",
      "সকল দিন অফিস খোলা",
      "pls phone number din",
      "please phone no dien",
      "bill generate korbo kivabe",
      "payment done",
      "[Image]",
      "",
    ]) {
      expect(detectCallMention(text)).toBeNull();
    }
  });

  it("a duration only where the message ties it to the call; otherwise unavailable", () => {
    expect(detectCallMention("15 min call hoise apnar sathe")).toMatchObject({ statedDurationSeconds: 15 * 60 });
    expect(detectCallMention("call lasted 7 minutes")).toMatchObject({ kind: "CALL_MENTIONED", statedDurationSeconds: 7 * 60 });
    expect(detectCallMention("১০ মিনিট কথা হয়েছে, কল দিয়েছি")).toMatchObject({ statedDurationSeconds: 600 });
    // A time to call is not a call's length.
    expect(detectCallMention("please call me in 10 minutes")).toMatchObject({ kind: "CALL_REQUESTED", statedDurationSeconds: null });
    expect(detectCallMention("ami call dicchi")!.statedDurationSeconds).toBeNull();
  });

  it("matches either encoding of the Bangla য়", () => {
    const precomposed = "কল দিয়েছি";
    const decomposed = "কল দিয়েছি";
    expect(detectCallMention(precomposed)?.kind).toBe("CALL_MENTIONED");
    expect(detectCallMention(decomposed)?.kind).toBe("CALL_MENTIONED");
  });
});

describe("report catalogue and date presets", () => {
  it("every report has a category, a question and at least one export; ids and routes are unique", () => {
    expect(new Set(REPORT_CATALOGUE.map((r) => r.id)).size).toBe(REPORT_CATALOGUE.length);
    expect(new Set(REPORT_CATALOGUE.map((r) => r.href)).size).toBe(REPORT_CATALOGUE.length);
    for (const r of REPORT_CATALOGUE) {
      expect(REPORT_CATEGORIES).toContain(r.category);
      expect(r.question.endsWith("?")).toBe(true);
      expect(r.exports.length).toBeGreaterThan(0);
      if (r.generic) expect(r.href).toBe(`/reports/${r.id}`);
    }
    // The three reports that predate the catalogue keep their routes.
    expect(REPORT_CATALOGUE.filter((r) => !r.generic).map((r) => r.href)).toEqual(["/team-report", "/support-activity/reports", "/team-management/attendance"]);
    expect(GENERIC_REPORT_IDS).toHaveLength(11);
  });

  it("presets map onto the existing period/date/from/to filters (Asia/Dhaka)", () => {
    // 2026-10-01 02:00 Dhaka = 2026-09-30 20:00 UTC: already the 1st in Dhaka.
    const now = new Date(Date.UTC(2026, 8, 30, 20, 0));
    expect(datePresetParams("today", now)).toEqual({ period: "day", date: "2026-10-01" });
    expect(datePresetParams("yesterday", now)).toEqual({ period: "day", date: "2026-09-30" });
    expect(datePresetParams("this_week", now)).toEqual({ period: "week", date: "2026-10-01" });
    expect(datePresetParams("last_week", now)).toEqual({ period: "week", date: "2026-09-24" });
    expect(datePresetParams("this_month", now)).toEqual({ period: "month", date: "2026-10-01" });
    expect(datePresetParams("last_month", now)).toEqual({ period: "month", date: "2026-09-30" });
    expect(datePresetParams("this_year", now)).toEqual({ period: "custom", from: "2026-01-01", to: "2026-10-01" });
    expect(datePresetParams("last_month", new Date(Date.UTC(2026, 0, 15)))).toEqual({ period: "month", date: "2025-12-31" });
    // Rolling windows end today and count today: 7 days is today and the six before it.
    expect(datePresetParams("last_7_days", now)).toEqual({ period: "custom", from: "2026-09-25", to: "2026-10-01" });
    expect(datePresetParams("last_30_days", now)).toEqual({ period: "custom", from: "2026-09-02", to: "2026-10-01" });
    expect(datePresetParams("last_60_days", now)).toEqual({ period: "custom", from: "2026-08-03", to: "2026-10-01" });
    expect(datePresetParams("last_90_days", now)).toEqual({ period: "custom", from: "2026-07-04", to: "2026-10-01" });
  });
});
