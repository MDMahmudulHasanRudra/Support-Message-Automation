import { describe, expect, it } from "vitest";
import {
  bucketKeysForRange,
  computeTeamReport,
  splitIntoStretches,
  UNASSIGNED,
  type ReportMessage,
  type TeamReportOptions,
} from "../teamReport.js";

/** 2026-09-10 00:00 Asia/Dhaka, in UTC milliseconds. */
const DAY = Date.UTC(2026, 8, 9, 18, 0, 0);
const MIN = 60_000;
const at = (minutesAfterDhakaMidnight: number) => DAY + minutesAfterDhakaMidnight * MIN;

const customer = (group: string, minute: number): ReportMessage => ({ groupKey: group, ts: at(minute), kind: "CUSTOMER", memberId: null });
const member = (group: string, minute: number, memberId: string): ReportMessage => ({ groupKey: group, ts: at(minute), kind: "MEMBER", memberId });
const business = (group: string, minute: number): ReportMessage => ({ groupKey: group, ts: at(minute), kind: "BUSINESS", memberId: null });

function options(overrides: Partial<TeamReportOptions> = {}): TeamReportOptions {
  return {
    rangeStart: DAY,
    rangeEnd: DAY + 86_400_000,
    now: DAY + 86_400_000,
    idleGapMs: 30 * MIN,
    missedAfterMs: () => 30 * MIN,
    assignedMemberFor: () => null,
    memberId: null,
    granularity: "day",
    ...overrides,
  };
}

describe("waits", () => {
  it("counts consecutive customer lines as ONE wait, closed by the next reply", () => {
    const report = computeTeamReport(
      [customer("A", 540), customer("A", 541), customer("A", 542), member("A", 545, "rudra")],
      options(),
    );
    expect(report.waits).toHaveLength(1);
    expect(report.waits[0]).toMatchObject({ status: "ON_TIME", repliedBy: "rudra", waitSeconds: 5 * 60 });
  });

  it("a reply after the threshold is Missed AND Recalled — one event, never two", () => {
    const report = computeTeamReport([customer("A", 540), member("A", 600, "rudra")], options());
    expect(report.summary).toMatchObject({ missed: 1, recalled: 1, unrecovered: 0 });
  });

  it("no reply past the threshold is Missed and unrecovered; inside it, Pending and neither", () => {
    const missed = computeTeamReport([customer("A", 540)], options({ now: at(600) }));
    expect(missed.waits[0]!.status).toBe("MISSED");
    expect(missed.summary).toMatchObject({ missed: 1, recalled: 0, unrecovered: 1 });

    const pending = computeTeamReport([customer("A", 540)], options({ now: at(550) }));
    expect(pending.waits[0]!.status).toBe("PENDING");
    expect(pending.summary).toMatchObject({ missed: 0, recalled: 0 });
  });

  it("uses the group's own threshold (its escalation SLA) when it has one", () => {
    const report = computeTeamReport(
      [customer("P1", 540), member("P1", 550, "rudra"), customer("N", 540), member("N", 550, "rudra")],
      options({ missedAfterMs: (g) => (g === "P1" ? 5 * MIN : 30 * MIN) }),
    );
    const byGroup = Object.fromEntries(report.waits.map((w) => [w.groupKey, w.status]));
    expect(byGroup).toEqual({ P1: "RECALLED", N: "ON_TIME" });
  });

  it("a business-number reply closes a wait too, but a Recall by it is credited to nobody", () => {
    const report = computeTeamReport([customer("A", 540), business("A", 600)], options());
    expect(report.waits[0]).toMatchObject({ status: "RECALLED", repliedBy: "BUSINESS" });
    expect(report.members.find((m) => m.memberId !== UNASSIGNED && m.recalled > 0)).toBeUndefined();
  });

  it("only waits that START inside the period count", () => {
    const report = computeTeamReport(
      [customer("A", -30), member("A", 10, "rudra")],
      options(),
    );
    expect(report.waits).toHaveLength(0);
  });
});

describe("attribution", () => {
  it("a Missed wait belongs to the group's assigned member; a Recall to whoever answered", () => {
    const report = computeTeamReport(
      [customer("A", 540), member("A", 620, "bipul")],
      options({ assignedMemberFor: () => "rudra" }),
    );
    const rudra = report.members.find((m) => m.memberId === "rudra")!;
    const bipul = report.members.find((m) => m.memberId === "bipul")!;
    expect(rudra).toMatchObject({ missed: 1, recalled: 0 });
    expect(bipul).toMatchObject({ missed: 0, recalled: 1 });
  });

  it("a miss in a group nobody is assigned to lands on UNASSIGNED, listed last", () => {
    const report = computeTeamReport([customer("A", 540), member("B", 541, "rudra")], options({ now: at(700) }));
    expect(report.members.map((m) => m.memberId)).toEqual(["rudra", UNASSIGNED]);
    expect(report.members.at(-1)).toMatchObject({ missed: 1, unrecovered: 1 });
  });

  it("one member's report counts only their groups, their replies and their misses", () => {
    const report = computeTeamReport(
      [customer("A", 540), member("A", 545, "rudra"), customer("B", 540), member("B", 545, "bipul")],
      options({ memberId: "rudra" }),
    );
    expect(report.summary).toMatchObject({ groupsSupported: 1, memberReplies: 1, customerMessages: 1 });
    expect(report.groups.map((g) => g.groupKey)).toEqual(["A"]);
  });
});

describe("support duration", () => {
  it("the spec's example: 30 minutes of silence splits one group's work into two stretches", () => {
    // 09:00 C, 09:02 R, 09:05 C, 09:08 R, [30 min], 09:40 C, 09:42 R — with a 30-minute gap rule.
    const report = computeTeamReport(
      [
        customer("A", 540), member("A", 542, "rudra"),
        customer("A", 545), member("A", 548, "rudra"),
        customer("A", 580), member("A", 582, "rudra"),
      ],
      options({ idleGapMs: 29 * MIN }),
    );
    const rudra = report.members.find((m) => m.memberId === "rudra")!;
    expect(rudra.stretches).toBe(2);
    expect(rudra.activeSeconds).toBe(6 * 60); // 09:02→09:08, then a single-message stretch at 09:42
  });

  it("two groups worked at once is one timeline, not two added together", () => {
    const report = computeTeamReport(
      [member("A", 600, "rudra"), member("B", 630, "rudra"), member("A", 660, "rudra")],
      options({ idleGapMs: 45 * MIN }),
    );
    expect(report.summary.activeSeconds).toBe(60 * 60);
    // Each group row measures its own timeline, so the rows may add up to more than the total.
    expect(report.groups.find((g) => g.groupKey === "A")!.activeSeconds).toBe(0); // 60 min gap > 45
  });

  it("a stretch never crosses Dhaka midnight", () => {
    expect(splitIntoStretches([at(1435), at(1445)], 60 * MIN)).toHaveLength(2);
  });
});

describe("buckets", () => {
  it("every day in the period appears, even with nothing in it", () => {
    expect(bucketKeysForRange(DAY, DAY + 3 * 86_400_000, "day")).toEqual(["2026-09-10", "2026-09-11", "2026-09-12"]);
  });

  it("a month period broken down by month is one bucket", () => {
    const start = Date.UTC(2026, 7, 31, 18);
    const end = Date.UTC(2026, 8, 30, 18);
    expect(bucketKeysForRange(start, end, "month")).toEqual(["2026-09"]);
  });

  it("bucket totals add up to the summary", () => {
    const report = computeTeamReport(
      [customer("A", 540), member("A", 545, "rudra"), customer("A", 900), business("A", 990)],
      options(),
    );
    const sum = (key: "memberMessages" | "customerMessages" | "missed" | "recalled") =>
      report.buckets.reduce((acc, b) => acc + b[key], 0);
    expect(sum("memberMessages")).toBe(report.summary.memberReplies);
    expect(sum("customerMessages")).toBe(report.summary.customerMessages);
    expect(sum("missed")).toBe(report.summary.missed);
    expect(sum("recalled")).toBe(report.summary.recalled);
  });
});
