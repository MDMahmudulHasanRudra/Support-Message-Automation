import { describe, expect, it } from "vitest";
import { applyResponseMessage, classifyResponseMessage, excelDhakaSerial, formatResponseDuration } from "../supportResponse.js";

const MIN = 60_000;
const at = (hhmm: string) => Date.parse(`2026-10-06T${hhmm}:00Z`);

describe("classifyResponseMessage", () => {
  it("a customer is anyone not on the roster", () => {
    expect(classifyResponseMessage({ direction: "INCOMING", memberId: null, inSupportTeam: false })).toBe("CUSTOMER");
  });
  it("a roster member is Support only while in a Support Team, otherwise another team", () => {
    expect(classifyResponseMessage({ direction: "INCOMING", memberId: "m1", inSupportTeam: true })).toBe("SUPPORT");
    expect(classifyResponseMessage({ direction: "INCOMING", memberId: "m1", inSupportTeam: false })).toBe("OTHER_TEAM");
  });
  it("anything the business number sent — rule, AI, dashboard, business phone — is never a Support reply", () => {
    expect(classifyResponseMessage({ direction: "OUTGOING", memberId: null, inSupportTeam: false })).toBe("BUSINESS");
    expect(classifyResponseMessage({ direction: "OUTGOING", memberId: "m1", inSupportTeam: true })).toBe("BUSINESS");
    expect(classifyResponseMessage({ direction: "SYSTEM", memberId: null, inSupportTeam: false })).toBe("IGNORED");
  });
});

describe("applyResponseMessage — one episode per wait", () => {
  it("the first customer message opens; the next ones extend the same episode", () => {
    expect(applyResponseMessage({ role: "CUSTOMER", at: at("10:00"), open: null, closedThroughAt: null })).toEqual({ kind: "OPEN" });
    expect(applyResponseMessage({ role: "CUSTOMER", at: at("10:05"), open: { firstIncomingAt: at("10:00"), latestIncomingAt: at("10:02") }, closedThroughAt: null })).toEqual({
      kind: "EXTEND",
      firstIncomingAt: at("10:00"),
      latestIncomingAt: at("10:05"),
      movesFirst: false,
      movesLatest: true,
    });
  });

  it("a Support reply answers, measured from the FIRST customer message, not the latest", () => {
    const open = { firstIncomingAt: at("10:00"), latestIncomingAt: at("10:05") };
    expect(applyResponseMessage({ role: "SUPPORT", at: at("10:11"), open, closedThroughAt: null })).toEqual({ kind: "ANSWER", responseSeconds: 11 * 60 });
  });

  it("another team, the business number and the AI never answer and never open", () => {
    const open = { firstIncomingAt: at("10:00"), latestIncomingAt: at("10:00") };
    for (const role of ["OTHER_TEAM", "BUSINESS", "IGNORED"] as const) {
      expect(applyResponseMessage({ role, at: at("10:03"), open, closedThroughAt: null })).toEqual({ kind: "NONE" });
      expect(applyResponseMessage({ role, at: at("10:03"), open: null, closedThroughAt: null })).toEqual({ kind: "NONE" });
    }
  });

  it("a Support message with nothing open does nothing — Support talking is not a wait", () => {
    expect(applyResponseMessage({ role: "SUPPORT", at: at("10:00"), open: null, closedThroughAt: null })).toEqual({ kind: "NONE" });
  });

  it("arrival order does not matter: a late customer message older than the last answer opens nothing", () => {
    expect(applyResponseMessage({ role: "CUSTOMER", at: at("09:58"), open: null, closedThroughAt: at("10:11") })).toEqual({ kind: "NONE" });
    expect(applyResponseMessage({ role: "CUSTOMER", at: at("10:20"), open: null, closedThroughAt: at("10:11") })).toEqual({ kind: "OPEN" });
  });

  it("a late customer message older than the open episode's first becomes its first", () => {
    const r = applyResponseMessage({ role: "CUSTOMER", at: at("09:55"), open: { firstIncomingAt: at("10:00"), latestIncomingAt: at("10:05") }, closedThroughAt: null });
    expect(r).toMatchObject({ kind: "EXTEND", firstIncomingAt: at("09:55"), latestIncomingAt: at("10:05"), movesFirst: true, movesLatest: false });
  });

  it("a Support reply sent before the episode began cannot be its answer", () => {
    const open = { firstIncomingAt: at("10:00"), latestIncomingAt: at("10:00") };
    expect(applyResponseMessage({ role: "SUPPORT", at: at("09:59"), open, closedThroughAt: null })).toEqual({ kind: "NONE" });
    expect(applyResponseMessage({ role: "SUPPORT", at: at("10:00"), open, closedThroughAt: null })).toEqual({ kind: "ANSWER", responseSeconds: 0 });
  });

  it("two cycles are two answers, each from its own first message", () => {
    const first = applyResponseMessage({ role: "SUPPORT", at: at("10:15"), open: { firstIncomingAt: at("10:00"), latestIncomingAt: at("10:10") }, closedThroughAt: null });
    const second = applyResponseMessage({ role: "SUPPORT", at: at("11:20"), open: { firstIncomingAt: at("11:00"), latestIncomingAt: at("11:05") }, closedThroughAt: at("10:15") });
    expect(first).toEqual({ kind: "ANSWER", responseSeconds: 15 * 60 });
    expect(second).toEqual({ kind: "ANSWER", responseSeconds: 20 * 60 });
    expect(MIN).toBe(60_000);
  });
});

describe("two Support replies moments apart, processed out of order", () => {
  it("the earlier one becomes the answer; a later one never replaces an earlier one", () => {
    const lastAnswered = { firstIncomingAt: at("10:00"), supportRepliedAt: at("10:12") };
    expect(applyResponseMessage({ role: "SUPPORT", at: at("10:11"), open: null, closedThroughAt: at("10:12"), lastAnswered })).toEqual({ kind: "REANSWER", responseSeconds: 11 * 60 });
    expect(applyResponseMessage({ role: "SUPPORT", at: at("10:13"), open: null, closedThroughAt: at("10:12"), lastAnswered })).toEqual({ kind: "NONE" });
    expect(applyResponseMessage({ role: "SUPPORT", at: at("09:59"), open: null, closedThroughAt: at("10:12"), lastAnswered })).toEqual({ kind: "NONE" });
  });
});

describe("formatting", () => {
  it("durations read at a glance", () => {
    expect(formatResponseDuration(45)).toBe("45s");
    expect(formatResponseDuration(18 * 60 + 42)).toBe("18m 42s");
    expect(formatResponseDuration(2 * 3600 + 5 * 60)).toBe("2h 05m");
    expect(formatResponseDuration(3 * 86400 + 4 * 3600)).toBe("3d 4h");
    expect(formatResponseDuration(null)).toBe("—");
  });
  it("Excel dates are Dhaka wall-clock serials", () => {
    // 2026-10-06 04:00 UTC is 10:00 in Dhaka: serial day 46301 + 10/24.
    expect(excelDhakaSerial(new Date("2026-10-06T04:00:00Z"))).toBeCloseTo(46301 + 10 / 24, 8);
  });
});
