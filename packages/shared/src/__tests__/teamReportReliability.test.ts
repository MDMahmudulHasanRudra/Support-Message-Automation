import { describe, expect, it } from "vitest";
import { computeTeamReport, type ReportMessage, type TeamReportOptions } from "../teamReport.js";
import { humanWaits, outgoingActorFor, type IntelActor, type IntelMessage } from "../intelligence/model.js";
import {
  computeReportingReliability,
  computeResponseMetrics,
  emptyActorCounts,
  reliabilityLines,
  replyCategoryOf,
  responseLines,
  REPLY_CATEGORIES,
  type ReliabilityCounts,
} from "../teamReportReliability.js";

/** 2026-09-10 00:00 Asia/Dhaka, in UTC milliseconds. */
const DAY = Date.UTC(2026, 8, 9, 18, 0, 0);
const DAY_MS = 86_400_000;
const MIN = 60_000;
const at = (minutes: number) => DAY + minutes * MIN;

function message(group: string, minute: number, actor: IntelActor, memberId: string | null = null): ReportMessage {
  const kind = actor === "CUSTOMER" ? "CUSTOMER" : actor === "MEMBER" || actor === "MEMBER_UNMAPPED" ? "MEMBER" : "BUSINESS";
  return { groupKey: group, ts: at(minute), kind, memberId, actor };
}

let seq = 0;
function intel(group: string, minute: number, actor: IntelActor, text: string | null = null): IntelMessage {
  seq += 1;
  return {
    key: `k${seq}`,
    groupKey: group,
    ts: at(minute),
    actor,
    memberId: actor === "MEMBER" ? "rina" : null,
    operatorUserId: actor === "OPERATOR" ? "u1" : null,
    sender: actor === "CUSTOMER" ? "c1" : "staff",
    senderName: null,
    text,
    quotedKey: null,
    quotedMemberId: null,
    mentionedMemberIds: [],
  };
}

function options(overrides: Partial<TeamReportOptions> = {}): TeamReportOptions {
  return {
    rangeStart: DAY,
    rangeEnd: DAY + DAY_MS,
    now: DAY + 2 * DAY_MS,
    idleGapMs: 30 * MIN,
    missedAfterMs: () => 30 * MIN,
    assignedMemberFor: () => null,
    memberId: null,
    granularity: "day",
    ...overrides,
  };
}

describe("reply categories (Workstream H §12.2)", () => {
  it("decides authorship from evidence, never from direction alone", () => {
    expect(REPLY_CATEGORIES).toEqual([
      "CUSTOMER",
      "HUMAN_TEAM_MEMBER",
      "AUTOMATED_AI",
      "AUTOMATED_RULE",
      "OTHER_BUSINESS_REPLY",
      "UNKNOWN_OR_UNATTRIBUTED",
    ]);
    // An outgoing message that echoes no send of ours is NOT a verified person and NOT the AI.
    expect(replyCategoryOf(outgoingActorFor(null, null))).toBe("OTHER_BUSINESS_REPLY");
    expect(replyCategoryOf(outgoingActorFor("AUTO_REPLY", null))).toBe("AUTOMATED_AI");
    expect(replyCategoryOf(outgoingActorFor("AUTO_REPLY", "rule-1"))).toBe("AUTOMATED_RULE");
    expect(replyCategoryOf(outgoingActorFor("MANUAL_REPLY", null))).toBe("HUMAN_TEAM_MEMBER");
    expect(replyCategoryOf(outgoingActorFor("GROUP_BROADCAST", null))).toBe("OTHER_BUSINESS_REPLY");
    expect(replyCategoryOf("MEMBER")).toBe("HUMAN_TEAM_MEMBER");
    expect(replyCategoryOf("MEMBER_UNMAPPED")).toBe("UNKNOWN_OR_UNATTRIBUTED");
    expect(replyCategoryOf("CUSTOMER")).toBe("CUSTOMER");
  });
});

describe("the Team Report's own figures do not move", () => {
  it("is byte-for-byte the same report with or without provenance, apart from the closing actor", () => {
    const withActors = [message("A", 60, "CUSTOMER"), message("A", 61, "AI"), message("A", 70, "CUSTOMER"), message("A", 120, "MEMBER", "rina")];
    const without = withActors.map(({ actor: _actor, ...rest }) => rest);
    const a = computeTeamReport(withActors, options());
    const b = computeTeamReport(without, options());
    expect(a.summary).toEqual(b.summary);
    expect(a.members).toEqual(b.members);
    expect(a.groups).toEqual(b.groups);
    expect(a.waits.map(({ repliedByActor: _x, ...rest }) => rest)).toEqual(b.waits);
    expect(a.waits.map((w) => w.repliedByActor)).toEqual(["AI", "MEMBER"]);
    expect(b.waits.every((w) => !("repliedByActor" in w))).toBe(true);
  });
});

describe("a wait that crosses the period boundary (Workstream H §12.5)", () => {
  // Customer at 23:50 on day 1, again at 00:10 on day 2, answered at 00:20 on day 2.
  const msgs = [message("A", -10, "CUSTOMER"), message("A", 10, "CUSTOMER"), message("A", 20, "MEMBER", "rina")];
  const day1 = { rangeStart: DAY - DAY_MS, rangeEnd: DAY };
  const day2 = { rangeStart: DAY, rangeEnd: DAY + DAY_MS };
  const both = { rangeStart: DAY - DAY_MS, rangeEnd: DAY + DAY_MS };

  it("counts once over the two days, so the days add up to the whole", () => {
    const whole = computeTeamReport(msgs, options(both)).summary.waits;
    const first = computeTeamReport(msgs, options(day1)).summary.waits;
    const second = computeTeamReport(msgs, options(day2)).summary.waits;
    expect(whole).toBe(1);
    expect(first + second).toBe(whole);
  });

  it("would count twice if the message before the period were not passed in — why the loader reads it", () => {
    const withoutContext = msgs.filter((m) => m.ts >= DAY);
    expect(computeTeamReport(withoutContext, options(day2)).summary.waits).toBe(1);
  });
});

describe("response measures (Workstream H §12.3)", () => {
  it("separates first observed response, automated response and the first verified human response", () => {
    // A: AI answers in 1 min, a person 40 min later. B: a person in 10 min. C: only the business phone.
    // D: nobody, past the threshold.
    const report = computeTeamReport(
      [
        message("A", 60, "CUSTOMER"),
        message("A", 61, "AI"),
        message("A", 100, "MEMBER", "rina"),
        message("B", 60, "CUSTOMER"),
        message("B", 70, "OPERATOR"),
        message("C", 60, "CUSTOMER"),
        message("C", 65, "BUSINESS_PHONE"),
        message("D", 60, "CUSTOMER"),
      ],
      options(),
    );
    const human = humanWaits(
      [
        intel("A", 60, "CUSTOMER", "my line is down"),
        intel("A", 61, "AI"),
        intel("A", 100, "MEMBER"),
        intel("B", 60, "CUSTOMER", "bill?"),
        intel("B", 70, "OPERATOR"),
        intel("C", 60, "CUSTOMER", "hello?"),
        intel("C", 65, "BUSINESS_PHONE"),
        intel("D", 60, "CUSTOMER", "anyone?"),
      ],
      { rangeStart: DAY, rangeEnd: DAY + DAY_MS, measuredTo: DAY + DAY_MS, thresholdMs: () => 30 * MIN },
    );

    const m = computeResponseMetrics({ waits: report.waits, humanWaits: human });

    // First observed response: the AI's one-minute reply closes A.
    expect(m.firstResponse).toMatchObject({ waits: 4, within: 3, never: 1, answered: 3, unansweredGroups: 1, pendingGroups: 0 });
    expect(m.firstReplyBy).toMatchObject({ AUTOMATED_AI: 1, HUMAN_TEAM_MEMBER: 1, OTHER_BUSINESS_REPLY: 1, UNCLASSIFIED: 0 });
    expect(m.automated).toEqual({ waits: 1, medianSeconds: 60, p90Seconds: 60 });
    // Human: A waited 40 minutes for a person — LATE, after automation. B by a verified person in 10.
    // C ended by a person nobody can name. D still missed.
    expect(m.human).toMatchObject({ waits: 4, answeredVerified: 2, answeredUnverified: 1, onTime: 2, late: 1, missed: 1, afterAutomation: 1 });
    expect(m.human.medianSeconds).toBe(25 * 60); // median of 10 and 40 minutes
  });

  it("limits both kinds of wait to the same groups", () => {
    const report = computeTeamReport([message("A", 60, "CUSTOMER"), message("A", 61, "MEMBER", "rina"), message("B", 60, "CUSTOMER")], options());
    const human = humanWaits([intel("A", 60, "CUSTOMER", "x?"), intel("A", 61, "MEMBER"), intel("B", 60, "CUSTOMER", "y?")], {
      rangeStart: DAY,
      rangeEnd: DAY + DAY_MS,
      measuredTo: DAY + DAY_MS,
      thresholdMs: () => 30 * MIN,
    });
    const m = computeResponseMetrics({ waits: report.waits, humanWaits: human, inScope: (g) => g === "A" });
    expect(m.firstResponse.waits).toBe(1);
    expect(m.human.waits).toBe(1);
  });

  it("says when replies carried no provenance instead of guessing one", () => {
    const report = computeTeamReport(
      [
        { groupKey: "A", ts: at(60), kind: "CUSTOMER", memberId: null },
        { groupKey: "A", ts: at(61), kind: "BUSINESS", memberId: null },
      ],
      options(),
    );
    expect(computeResponseMetrics({ waits: report.waits, humanWaits: [] }).firstReplyBy.UNCLASSIFIED).toBe(1);
  });
});

describe("reporting reliability (Workstream H §12.6)", () => {
  const counts: ReliabilityCounts = {
    storedCopies: 130,
    logicalMessages: 100,
    byActor: { ...emptyActorCounts(), CUSTOMER: 60, MEMBER: 25, MEMBER_UNMAPPED: 3, OPERATOR: 2, AI: 6, RULE: 1, BROADCAST: 1, BUSINESS_PHONE: 2 },
    attribution: { idAndPhone: 10, idOnly: 12, phoneOnly: 3 },
    conflicting: 1,
    unattributedSenders: 2,
  };
  const period = { start: DAY, end: DAY + 3 * DAY_MS, now: DAY + 3 * DAY_MS };

  it("counts copies, categories, gaps and days explicitly", () => {
    const r = computeReportingReliability(
      counts,
      {
        unverified: { from: DAY, to: DAY + DAY_MS },
        gaps: [
          { accountId: "a", accountLabel: "A", cause: "DISCONNECTED", startedAt: DAY + DAY_MS + 3_600_000, endedAt: DAY + DAY_MS + 7_200_000, recoveryStatus: "RECOVERED", recoveredCount: 4, recoveryNote: null, incomplete: false, text: "" },
          { accountId: "a", accountLabel: "A", cause: "WORKER_RESTART", startedAt: DAY + 2 * DAY_MS + 3_600_000, endedAt: DAY + 2 * DAY_MS + 7_200_000, recoveryStatus: "PARTIAL", recoveredCount: 2, recoveryNote: null, incomplete: true, text: "" },
        ],
      },
      period,
    );
    expect(r.duplicateCopies).toBe(30);
    expect(r.byCategory).toEqual({
      CUSTOMER: 60,
      HUMAN_TEAM_MEMBER: 27,
      AUTOMATED_AI: 6,
      AUTOMATED_RULE: 1,
      OTHER_BUSINESS_REPLY: 3,
      UNKNOWN_OR_UNATTRIBUTED: 3,
    });
    expect(Object.values(r.byCategory).reduce((a, b) => a + b, 0)).toBe(counts.logicalMessages);
    expect(r.gaps).toEqual({ total: 2, incomplete: 1, recoveredMessages: 6 });
    expect(r.days).toEqual({ total: 3, incomplete: 1, unverified: 1 });
  });

  it("never turns the counts into an invented accuracy percentage", () => {
    const r = computeReportingReliability(counts, { unverified: null, gaps: [] }, period);
    const report = computeTeamReport([message("A", 60, "CUSTOMER"), message("A", 61, "MEMBER", "rina")], options());
    const lines = [...responseLines(computeResponseMetrics({ waits: report.waits, humanWaits: [] })), ...reliabilityLines(r)];
    expect(lines.length).toBeGreaterThan(25);
    for (const line of lines) {
      expect(`${line.label} ${line.value} ${line.note}`).not.toMatch(/%|accuracy|score|confidence level/i);
    }
  });
});
