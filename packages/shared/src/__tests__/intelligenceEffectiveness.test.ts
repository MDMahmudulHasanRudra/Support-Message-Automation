import { describe, expect, it } from "vitest";
import { buildCases, type IntelActor, type IntelMessage, type IntelSettings } from "../intelligence/model.js";
import { appreciationSignals, customerPreferences, preferenceSignals } from "../intelligence/customerSignals.js";
import { effectivenessOf, leaderboard, splitByDuty, type EmployeeMetrics } from "../intelligence/effectiveness.js";

const M = 60_000;
const H = 60 * M;
const T0 = Date.UTC(2026, 9, 1, 4, 0); // 1 Oct 2026, 10:00 Dhaka
let seq = 0;
function msg(groupKey: string, at: number, actor: IntelActor, text: string | null = null, over: Partial<IntelMessage> = {}): IntelMessage {
  seq += 1;
  return {
    key: `e${seq}`,
    groupKey,
    ts: T0 + at,
    actor,
    memberId: actor === "MEMBER" ? (over.memberId ?? "rina") : null,
    operatorUserId: null,
    sender: actor === "CUSTOMER" ? (over.sender ?? "c1") : "x",
    senderName: null,
    text,
    quotedKey: null,
    quotedMemberId: null,
    mentionedMemberIds: [],
    ...over,
  };
}
const settings: IntelSettings = { caseGapMs: 4 * H, reopenWindowMs: 24 * H, sessionGapMs: 2 * H, thresholdMs: () => 30 * M };
const LATER = T0 + 5 * 24 * H;
const names = new Map([
  ["rina", "Rina Akter"],
  ["bipul", "Bipul Das"],
]);
const opts = { rangeStart: T0 - H, rangeEnd: T0 + 4 * 24 * H, caseGapMs: 4 * H };

describe("appreciation", () => {
  it("general thanks after the only employee's reply: GENERAL_THANKS, MEDIUM", () => {
    const ms = [msg("G", 0, "CUSTOMER", null), msg("G", 5 * M, "MEMBER", null), msg("G", 10 * M, "CUSTOMER", "Thank you ভাইয়া")];
    const [s] = appreciationSignals(ms, buildCases(ms, LATER, settings), names, opts);
    expect(s).toMatchObject({ kind: "GENERAL_THANKS", memberId: "rina", confidence: "MEDIUM" });
  });

  it("praise naming an employee: EMPLOYEE_PRAISE, MEDIUM; quoting them: HIGH", () => {
    const reply = msg("G", 5 * M, "MEMBER", null, { memberId: "bipul" });
    const ms = [
      msg("G", 0, "CUSTOMER", null),
      reply,
      msg("G", 6 * M, "MEMBER", null),
      msg("G", 10 * M, "CUSTOMER", "Bipul vai onek valo support den"),
      msg("G", 11 * M, "CUSTOMER", "great support", { quotedMemberId: "rina" }),
    ];
    const signals = appreciationSignals(ms, buildCases(ms, LATER, settings), names, opts);
    expect(signals.map((s) => [s.kind, s.memberId, s.confidence])).toEqual([
      ["EMPLOYEE_PRAISE", "bipul", "MEDIUM"],
      ["EMPLOYEE_PRAISE", "rina", "HIGH"],
    ]);
  });

  it("'thanks everyone' belongs to nobody; thanks with two employees replying is LOW", () => {
    const ms = [
      msg("G", 0, "CUSTOMER", null),
      msg("G", 5 * M, "MEMBER", null, { memberId: "rina" }),
      msg("G", 6 * M, "MEMBER", null, { memberId: "bipul" }),
      msg("G", 10 * M, "CUSTOMER", "Thanks everyone"),
      msg("G", 11 * M, "CUSTOMER", "thanks"),
    ];
    const [everyone, plain] = appreciationSignals(ms, buildCases(ms, LATER, settings), names, opts);
    expect(everyone).toMatchObject({ memberId: null, confidence: null });
    expect(plain!.confidence).toBe("LOW");
  });
});

describe("preference", () => {
  function history(cases: number, signalsText: string[]) {
    const ms: IntelMessage[] = [];
    for (let i = 0; i < cases; i++) {
      ms.push(msg("G", i * 6 * H, "CUSTOMER", null, { sender: "karim" }));
      ms.push(msg("G", i * 6 * H + 5 * M, "MEMBER", null));
    }
    signalsText.forEach((t, i) => ms.push(msg("G", i * 6 * H + 10 * M, "CUSTOMER", t, { sender: "karim" })));
    const cases_ = buildCases(ms, LATER, settings);
    const appreciation = appreciationSignals(ms, cases_, names, { ...opts, rangeEnd: LATER });
    return customerPreferences(cases_, preferenceSignals(ms, cases_, appreciation, names, { ...opts, rangeEnd: LATER }));
  }

  it("five cases and two explicit signals: PREFERRED", () => {
    const [p] = history(6, ["rina apu ke din", "আপনার কাছেই support নিতে চাই"]);
    expect(p).toMatchObject({ customer: "karim", memberId: "rina", status: "PREFERRED", signals: 2 });
    expect(p!.interactions).toBeGreaterThanOrEqual(5);
  });

  it("too few cases, or one signal: INSUFFICIENT_SAMPLE, never a negative", () => {
    expect(history(3, ["rina apu ke din", "apnakei chai"])[0]!.status).toBe("INSUFFICIENT_SAMPLE");
    expect(history(6, ["rina apu ke din"])[0]!.status).toBe("INSUFFICIENT_SAMPLE");
  });
});

describe("duty split", () => {
  // 1 Oct 2026 shift 10:00–19:00 Dhaka = 04:00–13:00 UTC.
  const shift = { day: "2026-10-01", start: T0, end: T0 + 9 * H };
  it("during duty, before, after, and on a day with no shift", () => {
    const split = splitByDuty(
      [
        { start: T0 - H, end: T0 + H }, // 09:00–11:00: 1h before, 1h in
        { start: T0 + 9 * H, end: T0 + 10 * H }, // 19:00–20:00: after
        { start: T0 + 24 * H, end: T0 + 25 * H }, // next day, no shift
      ],
      [shift],
    );
    expect(split).toEqual({ scheduledSeconds: 9 * 3600, inDutySeconds: 3600, beforeShiftSeconds: 3600, afterShiftSeconds: 3600, offDaySeconds: 3600 });
  });
});

function metrics(over: Partial<EmployeeMetrics> & { memberId: string }): EmployeeMetrics {
  return {
    observed: { observedSeconds: 10 * 3600, summedSessionSeconds: 10 * 3600, peakConcurrency: 1, averageConcurrency: 1, intervals: [] },
    sessions: 40,
    groups: 10,
    activeDays: 10,
    verifiedActiveDays: 10,
    waitsHandled: 100,
    waitsOnTime: 80,
    waitsLate: 20,
    medianResponseSeconds: 300,
    missedCharged: 0,
    casesParticipated: 100,
    casesOwned: 80,
    resolvedOwned: 60,
    resolvedOwnedHigh: 30,
    reopenedOwned: 4,
    complexOwned: 8,
    handoffsStated: 10,
    handoffsReturned: 8,
    handoffsResolved: 7,
    appreciationPraise: 5,
    appreciationThanks: 10,
    appreciationWeighted: 10,
    preferredByCustomers: 0,
    duty: { scheduledSeconds: 0, inDutySeconds: 0, beforeShiftSeconds: 0, afterShiftSeconds: 0, offDaySeconds: 0 },
    ...over,
  };
}

describe("effectiveness", () => {
  it("3 perfect cases do not outrank 200 well-handled ones: shrinkage and the eligibility threshold", () => {
    const rows = effectivenessOf([
      metrics({ memberId: "big", waitsHandled: 200, waitsOnTime: 180, casesParticipated: 200, casesOwned: 180, resolvedOwned: 160 }),
      metrics({ memberId: "tiny", waitsHandled: 3, waitsOnTime: 3, casesParticipated: 3, casesOwned: 3, resolvedOwned: 3, verifiedActiveDays: 1 }),
      metrics({ memberId: "mid" }),
    ]);
    const tiny = rows.find((r) => r.memberId === "tiny")!;
    expect(tiny).toMatchObject({ eligible: false, score: null, confidence: "INSUFFICIENT_SAMPLE" });
    expect(tiny.eligibilityNote).toBe("Insufficient sample: 3 of 20 human waits handled; 1 of 3 verified active days.");
    // Even its dimension scores are pulled toward the team rate, not 100.
    expect(tiny.dimensions.find((d) => d.dimension === "response")!.score).toBeLessThan(100);
    expect(leaderboard(rows, "overall").map((r) => r.memberId)).toEqual(["big", "mid"]);
    // Every leaderboard leaves an insufficient sample out — including "most active".
    expect(leaderboard(rows, "active").map((r) => r.memberId)).not.toContain("tiny");
  });

  it("every score shows its parts: weights, raw values, samples, positives, negatives, missing", () => {
    const [row] = effectivenessOf([metrics({ memberId: "a", handoffsStated: 0, handoffsResolved: 0 })]);
    expect(row!.dimensions.map((d) => [d.dimension, d.weight])).toEqual([
      ["response", 20],
      ["resolution", 20],
      ["ownership", 15],
      ["efficiency", 15],
      ["reliability", 10],
      ["appreciation", 10],
      ["handoff", 5],
      ["complexity", 5],
    ]);
    const handoff = row!.dimensions.find((d) => d.dimension === "handoff")!;
    expect(handoff).toMatchObject({ score: null, counted: false });
    expect(row!.missing).toEqual(["Hand-off follow-through: no opportunity in this period"]);
    expect(row!.dimensions[0]!.raw).toBe("80 of 100 on time");
  });

  it("a dimension with no opportunity is left out and the weights renormalised, not scored 0", () => {
    const withHandoffs = effectivenessOf([metrics({ memberId: "a" })])[0]!;
    const without = effectivenessOf([metrics({ memberId: "a", handoffsStated: 0, handoffsResolved: 0 })])[0]!;
    const counted = without.dimensions.filter((d) => d.counted);
    const expected = counted.reduce((s, d) => s + d.score! * d.weight, 0) / counted.reduce((s, d) => s + d.weight, 0);
    expect(without.score).toBeCloseTo(expected, 1);
    expect(without.score).not.toBe(withHandoffs.score === null ? -1 : 0);
  });

  it("efficiency and appreciation read 50 at the team rate", () => {
    const rows = effectivenessOf([metrics({ memberId: "a" }), metrics({ memberId: "b" })]);
    expect(rows[0]!.dimensions.find((d) => d.dimension === "efficiency")!.score).toBe(50);
    expect(rows[0]!.dimensions.find((d) => d.dimension === "appreciation")!.score).toBe(50);
  });

  it("separate leaderboards: the most active is not automatically the most efficient", () => {
    const rows = effectivenessOf([
      metrics({ memberId: "busy", sessions: 200, resolvedOwned: 40, observed: { observedSeconds: 60 * 3600, summedSessionSeconds: 60 * 3600, peakConcurrency: 3, averageConcurrency: 1.5, intervals: [] } }),
      metrics({ memberId: "sharp", sessions: 50, resolvedOwned: 70, observed: { observedSeconds: 10 * 3600, summedSessionSeconds: 10 * 3600, peakConcurrency: 2, averageConcurrency: 1.2, intervals: [] } }),
    ]);
    expect(leaderboard(rows, "active")[0]!.memberId).toBe("busy");
    expect(leaderboard(rows, "efficient")[0]!.memberId).toBe("sharp");
  });
});
