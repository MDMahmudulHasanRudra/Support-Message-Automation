import { describe, expect, it } from "vitest";
import {
  buildCases,
  buildSessions,
  humanWaits,
  observedTime,
  type IntelActor,
  type IntelMessage,
  type IntelSettings,
} from "../intelligence/model.js";

const M = 60_000;
const H = 60 * M;
const T0 = Date.UTC(2026, 9, 1, 4, 0); // 1 Oct 2026, 10:00 Dhaka
let seq = 0;
function msg(groupKey: string, at: number, actor: IntelActor, text: string | null = null, over: Partial<IntelMessage> = {}): IntelMessage {
  seq += 1;
  return {
    key: `k${seq}`,
    groupKey,
    ts: T0 + at,
    actor,
    memberId: actor === "MEMBER" ? (over.memberId ?? "rina") : null,
    operatorUserId: null,
    sender: actor === "CUSTOMER" ? "c1" : actor === "MEMBER" ? (over.memberId ?? "rina") : "biz",
    senderName: null,
    text,
    quotedKey: null,
    quotedMemberId: null,
    mentionedMemberIds: [],
    ...over,
  };
}
const settings: IntelSettings = { caseGapMs: 4 * H, reopenWindowMs: 24 * H, sessionGapMs: 2 * H, thresholdMs: () => 30 * M };
const LATER = T0 + 3 * 24 * H;

describe("cases", () => {
  it("a simple case: asked, answered, confirmed — resolved with HIGH confidence, owned by the only employee", () => {
    const ms = [msg("G", 0, "CUSTOMER", "internet not working"), msg("G", 5 * M, "MEMBER", "checking"), msg("G", 20 * M, "CUSTOMER", "yes it is working now, thank you")];
    const [c] = buildCases(ms, LATER, settings);
    expect(c).toMatchObject({ state: "RESOLVED", closed: true, customerMessages: 2, humanReplies: 1, turns: 2, memberIds: ["rina"] });
    expect(c!.resolution).toMatchObject({ confidence: "HIGH", basis: "The customer confirmed the problem is solved." });
    expect(c!.owner).toMatchObject({ memberId: "rina", confidence: "MEDIUM" });
    expect(c!.owner!.reasons).toContain("The only employee who replied");
  });

  it("several customer lines and replies are one case, not one per message", () => {
    const ms = [
      msg("G", 0, "CUSTOMER", null),
      msg("G", 1 * M, "CUSTOMER", null),
      msg("G", 2 * M, "CUSTOMER", null),
      msg("G", 10 * M, "MEMBER", null),
      msg("G", 12 * M, "MEMBER", null),
    ];
    expect(buildCases(ms, LATER, settings)).toHaveLength(1);
  });

  it("developer escalation: hand-off, return, fix, confirmation — ownership HIGH with the evidence spelled out", () => {
    const ms = [
      msg("G", 0, "CUSTOMER", "Internet not working"),
      msg("G", 2 * M, "MEMBER", "Hi"),
      msg("G", 3 * M, "MEMBER", "Please give me a moment"),
      msg("G", 6 * M, "MEMBER", "I have contacted the developer"),
      msg("G", 80 * M, "MEMBER", "Please check now"),
      msg("G", 90 * M, "CUSTOMER", "Yes, it is working. Thank you."),
    ];
    const [c] = buildCases(ms, LATER, settings);
    expect(c!.state).toBe("RESOLVED");
    expect(c!.resolution!.confidence).toBe("HIGH");
    expect(c!.handoffs.map((h) => [h.confidence, h.returned])).toEqual([
      ["LOW", true],
      ["HIGH", true],
    ]);
    expect(c!.owner).toMatchObject({ memberId: "rina", confidence: "HIGH" });
    expect(c!.owner!.reasons).toEqual(expect.arrayContaining(["Came back to the customer after the hand-off", "Told the customer it was fixed"]));
    expect(c!.complexity).toBe("MODERATE");
    expect(c!.complexityReasons).toEqual(expect.arrayContaining(["Needed an internal hand-off", "Ran for over an hour"]));
  });

  it("ownership is evidence, not the last replier", () => {
    const ms = [
      msg("G", 0, "CUSTOMER", "billing not working"),
      msg("G", 3 * M, "MEMBER", "I'll check with the developer", { memberId: "rina" }),
      msg("G", 60 * M, "MEMBER", "It has been fixed, please check now", { memberId: "rina" }),
      msg("G", 70 * M, "CUSTOMER", "thik hoyeche, thanks"),
      msg("G", 72 * M, "MEMBER", "welcome", { memberId: "bipul" }),
    ];
    const [c] = buildCases(ms, LATER, settings);
    expect(c!.owner!.memberId).toBe("rina");
    expect(c!.owner!.confidence).toBe("HIGH");
  });

  it("an employee saying it is fixed, with no customer complaint after, is MEDIUM", () => {
    const ms = [msg("G", 0, "CUSTOMER", null), msg("G", 10 * M, "MEMBER", "Done vai, check korun")];
    const [c] = buildCases(ms, LATER, settings);
    expect(c!.resolution!.confidence).toBe("MEDIUM");
  });

  it("'thanks, but still not working' undoes the fix the employee stated", () => {
    const ms = [msg("G", 0, "CUSTOMER", null), msg("G", 10 * M, "MEMBER", "Done, check now"), msg("G", 20 * M, "CUSTOMER", "thanks, but still not working")];
    const [c] = buildCases(ms, LATER, settings);
    expect(c!.resolution).toBeNull();
  });

  it("a conversation that simply stops is 'no further contact', never resolved", () => {
    const ms = [msg("G", 0, "CUSTOMER", null), msg("G", 10 * M, "MEMBER", "What is your user id?")];
    const [c] = buildCases(ms, LATER, settings);
    expect(c).toMatchObject({ state: "ABANDONED", resolution: null });
  });

  it("missed: asked, never answered, past the case gap", () => {
    const [c] = buildCases([msg("G", 0, "CUSTOMER", null)], LATER, settings);
    expect(c).toMatchObject({ state: "MISSED", awaitingReply: true });
  });

  it("open states: active, waiting for the customer, waiting internally", () => {
    const now = T0 + 30 * M;
    expect(buildCases([msg("A", 0, "CUSTOMER", null)], now, settings)[0]!.state).toBe("ACTIVE");
    expect(buildCases([msg("B", 0, "CUSTOMER", null), msg("B", 5 * M, "MEMBER", "Which router?")], now, settings)[0]!.state).toBe("WAITING_CUSTOMER");
    expect(buildCases([msg("C", 0, "CUSTOMER", null), msg("C", 5 * M, "MEMBER", "I have forwarded this to the technical team")], now, settings)[0]!.state).toBe(
      "WAITING_INTERNAL",
    );
  });

  it("a long silence splits two problems into two cases", () => {
    const ms = [msg("G", 0, "CUSTOMER", null), msg("G", 5 * H, "CUSTOMER", null), msg("G", 5 * H + 5 * M, "MEMBER", null)];
    const cases = buildCases(ms, LATER, settings);
    expect(cases.map((c) => c.state)).toEqual(["MISSED", "ABANDONED"]);
  });

  it("reopens only on continuity: 'still not working' next morning carries the case on", () => {
    const ms = [
      msg("G", 0, "CUSTOMER", "no internet"),
      msg("G", 10 * M, "MEMBER", "fixed, please check now"),
      msg("G", 14 * H, "CUSTOMER", "still not working"),
    ];
    const cases = buildCases(ms, T0 + 14 * H + 10 * M, settings);
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ reopened: true, state: "REOPENED", resolution: null });
    expect(cases[0]!.supersededResolutions).toHaveLength(1);
  });

  it("…and an unrelated question the next day is a new case, not a reopen", () => {
    const ms = [msg("G", 0, "CUSTOMER", "no internet"), msg("G", 10 * M, "MEMBER", "fixed, please check now"), msg("G", 14 * H, "CUSTOMER", "how do I pay my bill?")];
    const cases = buildCases(ms, LATER, settings);
    expect(cases).toHaveLength(2);
    expect(cases[0]!.state).toBe("RESOLVED");
    expect(cases[1]!.reopened).toBe(false);
  });

  it("a quote of the case's own message is continuity too", () => {
    const fix = msg("G", 10 * M, "MEMBER", "Done, check now");
    const ms = [msg("G", 0, "CUSTOMER", "no internet"), fix, msg("G", 6 * H, "CUSTOMER", "what about this one?", { quotedKey: fix.key })];
    expect(buildCases(ms, LATER, settings)).toHaveLength(1);
  });

  it("a new question straight after 'it's fixed' is a new problem", () => {
    const ms = [msg("G", 0, "CUSTOMER", "no internet"), msg("G", 10 * M, "MEMBER", "done, check now"), msg("G", 20 * M, "CUSTOMER", "also, my bill is wrong")];
    expect(buildCases(ms, LATER, settings)).toHaveLength(2);
  });

  it("a bare acknowledgement never opens a case", () => {
    const ms = [msg("G", 0, "CUSTOMER", "ok"), msg("G", 1 * M, "CUSTOMER", "ji vai 👍")];
    expect(buildCases(ms, LATER, settings)).toHaveLength(0);
  });

  it("'thanks everyone' is not read as this case's confirmation", () => {
    const ms = [msg("G", 0, "CUSTOMER", null), msg("G", 5 * M, "MEMBER", null), msg("G", 10 * M, "CUSTOMER", "thanks everyone")];
    expect(buildCases(ms, LATER, settings)[0]!.resolution).toBeNull();
  });

  it("an admin resolving the SLA escalation is a HIGH fact; an open escalation shows as ESCALATED", () => {
    const ms = [msg("G", 0, "CUSTOMER", null), msg("G", 40 * M, "MEMBER", null)];
    const resolved = buildCases(ms, LATER, settings, { escalations: [{ groupKey: "G", openedAt: T0 + 30 * M, closedAt: T0 + 2 * H, resolvedByAdminAt: T0 + 2 * H }], keywordCompletions: [] });
    expect(resolved[0]!.resolution).toMatchObject({ confidence: "HIGH", evidence: { messageKey: null } });
    expect(resolved[0]!.escalated).toBe(true);
    const open = buildCases([msg("H", 0, "CUSTOMER", null)], T0 + 50 * M, settings, {
      escalations: [{ groupKey: "H", openedAt: T0 + 30 * M, closedAt: null, resolvedByAdminAt: null }],
      keywordCompletions: [],
    });
    expect(open[0]!.state).toBe("ESCALATED");
  });

  it("a team message with no case open belongs to no case", () => {
    expect(buildCases([msg("G", 0, "MEMBER", "Good morning everyone")], LATER, settings)).toHaveLength(0);
  });
});

describe("sessions and observed time", () => {
  it("three overlapping groups are 50 minutes of observed time, not 90 — with peak concurrency 3", () => {
    const ms = [
      msg("A", 0, "MEMBER", null),
      msg("A", 30 * M, "MEMBER", null),
      msg("B", 10 * M, "MEMBER", null),
      msg("B", 40 * M, "MEMBER", null),
      msg("C", 20 * M, "MEMBER", null),
      msg("C", 50 * M, "MEMBER", null),
    ];
    const sessions = buildSessions(ms, [], settings);
    expect(sessions).toHaveLength(3);
    const t = observedTime(sessions);
    expect(t).toMatchObject({ observedSeconds: 50 * 60, summedSessionSeconds: 90 * 60, peakConcurrency: 3, averageConcurrency: 1.8 });
  });

  it("a session ends when the employee goes quiet in that group past the gap; one message is zero seconds", () => {
    const ms = [msg("A", 0, "MEMBER", null), msg("A", 20 * M, "MEMBER", null), msg("A", 3 * H, "MEMBER", null)];
    const sessions = buildSessions(ms, [], settings);
    expect(sessions.map((s) => (s.end - s.start) / M)).toEqual([20, 0]);
  });

  it("AI, rules and the business phone never create an employee session", () => {
    expect(buildSessions([msg("A", 0, "AI", null), msg("A", 1 * M, "RULE", null), msg("A", 2 * M, "BUSINESS_PHONE", null)], [], settings)).toHaveLength(0);
  });

  it("a session knows the cases it touched and their state", () => {
    const ms = [msg("G", 0, "CUSTOMER", null), msg("G", 5 * M, "MEMBER", "done, check now")];
    const cases = buildCases(ms, LATER, settings);
    const [s] = buildSessions(ms, cases, settings);
    expect(s).toMatchObject({ caseIds: [cases[0]!.id], state: "RESOLVED" });
  });
});

describe("human waits", () => {
  const opts = { rangeStart: T0 - H, rangeEnd: T0 + 24 * H, measuredTo: LATER, thresholdMs: () => 30 * M };

  it("an AI answer at once and a person forty minutes later is a 40-minute LATE human wait", () => {
    const ms = [msg("G", 0, "CUSTOMER", null), msg("G", 1 * M, "AI", null), msg("G", 40 * M, "MEMBER", null)];
    const [w] = humanWaits(ms, opts);
    expect(w).toMatchObject({ status: "LATE", waitSeconds: 40 * 60, automatedFirstActor: "AI", repliedBy: { actor: "MEMBER", memberId: "rina" } });
  });

  it("a rule reply alone never answers: MISSED once past the threshold", () => {
    const [w] = humanWaits([msg("G", 0, "CUSTOMER", null), msg("G", 1 * M, "RULE", null)], opts);
    expect(w).toMatchObject({ status: "MISSED", repliedAt: null, automatedFirstActor: "RULE" });
  });

  it("the business phone and a dashboard operator are human replies, attributed as such", () => {
    const [a] = humanWaits([msg("A", 0, "CUSTOMER", null), msg("A", 10 * M, "BUSINESS_PHONE", null)], opts);
    const [b] = humanWaits([msg("B", 0, "CUSTOMER", null), msg("B", 10 * M, "OPERATOR", null, { operatorUserId: "u1" })], opts);
    expect(a).toMatchObject({ status: "ON_TIME", repliedBy: { actor: "BUSINESS_PHONE", memberId: null } });
    expect(b).toMatchObject({ status: "ON_TIME", repliedBy: { actor: "OPERATOR", operatorUserId: "u1" } });
  });

  it("customer lines in a row are one wait; still inside the threshold is PENDING", () => {
    const ws = humanWaits([msg("G", 0, "CUSTOMER", null), msg("G", 2 * M, "CUSTOMER", null)], { ...opts, measuredTo: T0 + 10 * M });
    expect(ws).toHaveLength(1);
    expect(ws[0]!.status).toBe("PENDING");
  });

  it("only waits starting inside the period count", () => {
    const ws = humanWaits([msg("G", -2 * H, "CUSTOMER", null), msg("G", -2 * H + 5 * M, "MEMBER", null)], opts);
    expect(ws).toHaveLength(0);
  });
});
