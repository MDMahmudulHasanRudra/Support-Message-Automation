import { describe, expect, it } from "vitest";
import { computeTeamReport, type ReportMessage, type TeamMembershipInterval, inTeamAt } from "../teamReport.js";
import { humanWaits, isMemberWork, type IntelMessage } from "../intelligence/model.js";
import { resolveRegularDuty } from "../overtime.js";

/**
 * Team Report audit (19 Oct 2026, Phase A), the pure rules:
 *  - a wait carries who it is charged to: the assignee WHEN THE CUSTOMER ASKED;
 *  - the human-response measure uses the threshold in force then, not today's;
 *  - a Team/member report's group rows add up to its own Missed and Recall, and a group where its
 *    member only answered late is part of it;
 *  - overtime is a whole day's, shared to the Team by its part of the day — never lost when somebody
 *    changed Team mid-day;
 *  - a reply typed in WhatsApp Chat and credited to a member is that member's work.
 */

const DAY = Date.UTC(2025, 4, 14) - 6 * 3_600_000; // Dhaka midnight
const at = (h: number, m = 0) => DAY + h * 3_600_000 + m * 60_000;
const msg = (groupKey: string, ts: number, kind: ReportMessage["kind"], memberId: string | null = null): ReportMessage => ({ groupKey, ts, kind, memberId });
const base = {
  rangeStart: DAY,
  rangeEnd: DAY + 86_400_000,
  now: DAY + 3 * 86_400_000,
  idleGapMs: 2 * 3_600_000,
  granularity: "day" as const,
  memberId: null,
};

describe("charged at the time", () => {
  it("records each wait's owner from the assignee when the customer asked", () => {
    const report = computeTeamReport([msg("G", at(9), "CUSTOMER"), msg("G", at(15), "CUSTOMER")], {
      ...base,
      missedAfterMs: () => 30 * 60_000,
      // Rakib until noon, Bipul after.
      assignedMemberFor: (_g, ts) => (ts !== undefined && ts < at(12) ? "rakib" : "bipul"),
    });
    expect(report.waits.map((w) => w.chargedTo)).toEqual(["rakib"]);
    expect(report.members.find((m) => m.memberId === "rakib")?.missed).toBe(1);
  });

  it("judges each wait by the threshold in force when the customer asked", () => {
    const report = computeTeamReport([msg("G", at(9), "CUSTOMER"), msg("G", at(9, 20), "MEMBER", "rina")], {
      ...base,
      // A 10-minute priority until noon; the 30-minute default after it was removed.
      missedAfterMs: (_g, ts) => (ts !== undefined && ts < at(12) ? 10 * 60_000 : 30 * 60_000),
      assignedMemberFor: () => null,
    });
    expect(report.waits[0]).toMatchObject({ status: "RECALLED", thresholdSeconds: 600 });
  });
});

describe("the human-response measure", () => {
  const intel = (key: string, ts: number, actor: IntelMessage["actor"], memberId: string | null = null): IntelMessage => ({
    key,
    groupKey: "G",
    ts,
    actor,
    memberId,
    operatorUserId: null,
    sender: actor === "CUSTOMER" ? "c" : "m",
    senderName: null,
    text: "my internet is down",
    quotedKey: null,
    quotedMemberId: null,
    mentionedMemberIds: [],
  });

  it("uses the threshold of the moment the customer asked, as the waits beside it do", () => {
    const waits = humanWaits([intel("a", at(9), "CUSTOMER"), intel("b", at(9, 20), "MEMBER", "rina")], {
      rangeStart: DAY,
      rangeEnd: DAY + 86_400_000,
      measuredTo: DAY + 86_400_000,
      thresholdMs: (_g, ts) => (ts !== undefined && ts < at(12) ? 10 * 60_000 : 30 * 60_000),
    });
    expect(waits[0]).toMatchObject({ status: "LATE", thresholdSeconds: 600 });
  });

  it("keeps the caller's order for two messages in the same second", () => {
    // The question was stored before the reply: the reply answers it, whatever their keys say.
    const waits = humanWaits([intel("z", at(9), "CUSTOMER"), intel("a", at(9), "MEMBER", "rina")], {
      rangeStart: DAY,
      rangeEnd: DAY + 86_400_000,
      measuredTo: DAY + 86_400_000,
      thresholdMs: () => 30 * 60_000,
    });
    expect(waits[0]).toMatchObject({ status: "ON_TIME", waitSeconds: 0 });
  });

  it("counts a WhatsApp Chat reply credited to a member as that member's work", () => {
    expect(isMemberWork({ actor: "OPERATOR", memberId: "rina" })).toBe(true);
    expect(isMemberWork({ actor: "OPERATOR", memberId: null })).toBe(false);
    expect(isMemberWork({ actor: "MEMBER", memberId: "rina" })).toBe(true);
  });
});

describe("a Team report adds up", () => {
  const memberships: TeamMembershipInterval[] = [
    { memberId: "rina", teamId: "support", startedAt: null, endedAt: null },
    { memberId: "mahfuz", teamId: "commercial", startedAt: null, endedAt: null },
  ];
  const scope = (team: string) => (id: string, ts: number) => inTeamAt(memberships, id, team, ts);

  it("lists the group where its member only answered late, with group rows matching the headline", () => {
    // G is Mahfuz's (Commercial). A customer asks at 23:30; Rina (Support) answers at 00:45 next day —
    // in the look-ahead, so she sent nothing in G inside the period.
    const report = computeTeamReport([msg("G", at(23, 30), "CUSTOMER"), msg("G", at(24, 45), "MEMBER", "rina")], {
      ...base,
      missedAfterMs: () => 30 * 60_000,
      assignedMemberFor: () => "mahfuz",
      scope: scope("support"),
    });
    expect(report.summary).toMatchObject({ recalled: 1, missed: 0 });
    expect(report.groups.map((g) => g.groupKey)).toEqual(["G"]);
    const sum = (k: "missed" | "recalled") => report.groups.reduce((s, g) => s + g[k], 0);
    expect({ missed: sum("missed"), recalled: sum("recalled") }).toEqual({ missed: report.summary.missed, recalled: report.summary.recalled });
  });

  it("shows only the Team's own members on a group row", () => {
    const report = computeTeamReport(
      [msg("G", at(9), "CUSTOMER"), msg("G", at(9, 5), "MEMBER", "rina"), msg("G", at(9, 6), "MEMBER", "mahfuz")],
      { ...base, missedAfterMs: () => 30 * 60_000, assignedMemberFor: () => null, scope: scope("support") },
    );
    expect(report.groups[0]!.memberIds).toEqual(["rina"]);
  });
});

describe("overtime is a whole day's", () => {
  it("is shared between the two Teams of somebody who moved Team mid-day, never lost", () => {
    // Rina works 08:00–20:00 (12 h, messages every hour) with an 8 h duty: 4 h overtime. She moves
    // from Support to Billing at 14:00.
    const memberships: TeamMembershipInterval[] = [
      { memberId: "rina", teamId: "support", startedAt: null, endedAt: at(14) },
      { memberId: "rina", teamId: "billing", startedAt: at(14), endedAt: null },
    ];
    const messages = Array.from({ length: 13 }, (_, i) => msg("G", at(8 + i), "MEMBER", "rina"));
    const duty = resolveRegularDuty({ assignment: null, isHoliday: false, pattern: null, defaultShift: null, fallbackMinutes: 480 });
    const run = (team: string | null) =>
      computeTeamReport(messages, {
        ...base,
        missedAfterMs: () => 30 * 60_000,
        assignedMemberFor: () => null,
        dutyFor: () => duty,
        scope: team ? (id, ts) => inTeamAt(memberships, id, team, ts) : null,
      }).summary.overtimeSeconds;
    expect(run(null)).toBe(4 * 3600);
    expect(run("support") + run("billing")).toBeGreaterThanOrEqual(4 * 3600 - 2);
    expect(run("support")).toBeGreaterThan(0);
    expect(run("billing")).toBeGreaterThan(0);
  });
});
