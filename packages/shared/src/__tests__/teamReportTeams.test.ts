import { describe, expect, it } from "vitest";
import {
  computeTeamReport,
  inTeamAt,
  membersOfTeamDuring,
  NO_TEAM,
  type ReportMessage,
  type TeamMembershipInterval,
  type TeamReportOptions,
} from "../teamReport.js";

/**
 * The Team filter on the Team Report: a Team is "who was in it at that moment", so a member who
 * changes team mid-period keeps their history where it happened.
 */

/** 2026-09-10 00:00 Asia/Dhaka, in UTC milliseconds. */
const DAY = Date.UTC(2026, 8, 9, 18, 0, 0);
const MIN = 60_000;
const at = (minute: number) => DAY + minute * MIN;

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

// rudra and bipul are Support; mahfuz is Commercial; nibir is in no team.
const memberships: TeamMembershipInterval[] = [
  { memberId: "rudra", teamId: "support", startedAt: null, endedAt: null },
  { memberId: "bipul", teamId: "support", startedAt: null, endedAt: null },
  { memberId: "mahfuz", teamId: "commercial", startedAt: null, endedAt: null },
];
const teamScope = (teamId: string, intervals = memberships) => (id: string, ts: number) => inTeamAt(intervals, id, teamId, ts);

const day = [
  customer("A", 540), member("A", 545, "rudra"),
  customer("B", 540), member("B", 550, "bipul"), member("B", 551, "rudra"),
  customer("C", 540), member("C", 560, "mahfuz"),
  customer("D", 540), member("D", 541, "nibir"),
  customer("E", 540), business("E", 542),
];

describe("Team scope", () => {
  it("counts only the Team's members, and a group two of them share once", () => {
    const report = computeTeamReport(day, options({ scope: teamScope("support") }));
    expect(report.summary).toMatchObject({
      groupsSupported: 2, // A and B
      memberReplies: 3,
      customerMessages: 2, // one in A, one in B — B is not counted twice for two colleagues
      waits: 2,
      businessReplies: 0,
      activeMembers: 2,
    });
    expect(report.members.map((m) => m.memberId).sort()).toEqual(["bipul", "rudra"]);
    expect(report.groups.map((g) => g.groupKey).sort()).toEqual(["A", "B"]);
  });

  it("another Team and the no-team bucket see only their own people", () => {
    const commercial = computeTeamReport(day, options({ scope: teamScope("commercial") }));
    expect(commercial.summary).toMatchObject({ groupsSupported: 1, memberReplies: 1 });
    const none = computeTeamReport(day, options({ scope: teamScope(NO_TEAM) }));
    expect(none.members.map((m) => m.memberId)).toEqual(["nibir"]);
  });

  it("Team + member narrows to that member, and differs from the whole Team", () => {
    const intervals = memberships;
    const team = computeTeamReport(day, options({ scope: teamScope("support") }));
    const one = computeTeamReport(
      day,
      options({ scope: (id, ts) => id === "rudra" && inTeamAt(intervals, id, "support", ts) }),
    );
    expect(one.summary.memberReplies).toBe(2);
    expect(team.summary.memberReplies).toBe(3);
  });

  it("a scope that only names one member gives exactly the member report", () => {
    const viaMember = computeTeamReport(day, options({ memberId: "rudra", assignedMemberFor: () => "rudra" }));
    const viaScope = computeTeamReport(
      day,
      options({ scope: (id) => id === "rudra", assignedMemberFor: () => "rudra" }),
    );
    expect(viaScope).toEqual(viaMember);
  });

  it("the whole team is unchanged when no scope is given", () => {
    const report = computeTeamReport(day, options());
    expect(report.summary).toMatchObject({ groupsSupported: 5, memberReplies: 5, businessReplies: 1, customerMessages: 5 });
  });

  it("a member who changed team mid-day counts for each Team only while in it", () => {
    const moved: TeamMembershipInterval[] = [
      { memberId: "rudra", teamId: "support", startedAt: null, endedAt: at(720) },
      { memberId: "rudra", teamId: "billing", startedAt: at(720), endedAt: null },
    ];
    const messages = [member("A", 600, "rudra"), member("A", 610, "rudra"), member("B", 800, "rudra"), member("B", 805, "rudra")];
    const support = computeTeamReport(messages, options({ scope: teamScope("support", moved) }));
    const billing = computeTeamReport(messages, options({ scope: teamScope("billing", moved) }));
    expect(support.summary).toMatchObject({ memberReplies: 2, groupsSupported: 1, activeSeconds: 10 * 60 });
    expect(billing.summary).toMatchObject({ memberReplies: 2, groupsSupported: 1, activeSeconds: 5 * 60 });
    expect(support.groups.map((g) => g.groupKey)).toEqual(["A"]);
    expect(billing.groups.map((g) => g.groupKey)).toEqual(["B"]);
  });

  it("Missed follows the group's assigned member's Team; Recall the late replier's", () => {
    // A is assigned to mahfuz (Commercial) and answered late by rudra (Support).
    const messages = [customer("A", 540), member("A", 620, "rudra")];
    const assigned = () => "mahfuz";
    const support = computeTeamReport(messages, options({ scope: teamScope("support"), assignedMemberFor: assigned }));
    const commercial = computeTeamReport(messages, options({ scope: teamScope("commercial"), assignedMemberFor: assigned }));
    expect(support.summary).toMatchObject({ missed: 0, recalled: 1 });
    expect(commercial.summary).toMatchObject({ missed: 1, recalled: 0 });
    expect(commercial.members).toEqual([expect.objectContaining({ memberId: "mahfuz", missed: 1 })]);
    // The export's Missed & Recall sheet lists exactly the waits behind those figures.
    expect(support.countedMissedWaits).toHaveLength(1);
    expect(commercial.countedMissedWaits).toHaveLength(1);
  });

  it("chart buckets add up to the scoped summary", () => {
    const report = computeTeamReport(day, options({ scope: teamScope("support") }));
    const total = report.buckets.reduce((sum, b) => sum + b.memberMessages + b.businessReplies, 0);
    expect(total).toBe(report.summary.memberReplies);
    expect(report.buckets.reduce((sum, b) => sum + b.customerMessages, 0)).toBe(report.summary.customerMessages);
  });

  it("a Team with nobody in it is an empty report, not the whole team", () => {
    const report = computeTeamReport(day, options({ scope: teamScope("hr") }));
    expect(report.summary).toMatchObject({ groupsSupported: 0, memberReplies: 0, customerMessages: 0, waits: 0 });
  });
});

describe("membersOfTeamDuring (the cascading member list)", () => {
  const ids = ["rudra", "bipul", "mahfuz", "nibir"];
  it("lists who was in the Team at any moment of the period", () => {
    expect(membersOfTeamDuring(memberships, ids, "support", DAY, DAY + 86_400_000)).toEqual(["rudra", "bipul"]);
  });

  it("includes someone who left during the period, excludes someone who joined after it", () => {
    const intervals: TeamMembershipInterval[] = [
      { memberId: "rudra", teamId: "support", startedAt: null, endedAt: at(600) },
      { memberId: "bipul", teamId: "support", startedAt: at(2000), endedAt: null },
    ];
    expect(membersOfTeamDuring(intervals, ids, "support", DAY, DAY + 86_400_000)).toEqual(["rudra"]);
  });

  it("no team: anyone outside every Team for part of the period", () => {
    const intervals: TeamMembershipInterval[] = [
      { memberId: "rudra", teamId: "support", startedAt: null, endedAt: null },
      { memberId: "bipul", teamId: "support", startedAt: at(600), endedAt: null },
    ];
    expect(membersOfTeamDuring(intervals, ids, NO_TEAM, DAY, DAY + 86_400_000)).toEqual(["bipul", "mahfuz", "nibir"]);
  });
});
