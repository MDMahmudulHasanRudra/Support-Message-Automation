import { describe, expect, it } from "vitest";
import {
  computeReplyAttribution,
  computeTeamReport,
  REPLY_ATTRIBUTION_VERSION,
  REPLY_LINK_TIERS,
  VERIFIED_LINK_TIERS,
  type ReplyAttributionOptions,
  type ReplyEvidenceMessage,
  type ReportMessage,
} from "../index.js";

/**
 * Customer-specific reply attribution (06 §3), constructed conversations only. Synthetic ids: customers
 * 8801000000001 / 8801000000002 / a LID 100000000003, a team member's reply and a broadcast.
 */

const T0 = Date.UTC(2025, 6, 8, 3, 0); // 09:00 Dhaka on the 8th
const min = (n: number) => T0 + n * 60_000;
const G = "120000000000000001@g.us";
const A = "8801000000001";
const B = "8801000000002";
const L = "100000000003";

const OPTS: ReplyAttributionOptions = {
  rangeStart: T0 - 3_600_000,
  rangeEnd: T0 + 24 * 3_600_000,
  measuredTo: T0 + 48 * 3_600_000,
  thresholdMs: () => 30 * 60_000,
};

let seq = 0;
const customer = (at: number, ids: string[], extra: Partial<ReplyEvidenceMessage> = {}): ReplyEvidenceMessage => ({
  key: `c${(seq += 1)}`,
  groupKey: G,
  ts: min(at),
  kind: "CUSTOMER",
  actor: "CUSTOMER",
  memberId: null,
  customerIds: ids,
  quotedKey: null,
  mentionedIds: [],
  inPeriod: true,
  ...extra,
});
const reply = (at: number, extra: Partial<ReplyEvidenceMessage> = {}): ReplyEvidenceMessage => ({
  key: `r${(seq += 1)}`,
  groupKey: G,
  ts: min(at),
  kind: "MEMBER",
  actor: "MEMBER",
  memberId: "rina",
  customerIds: [],
  quotedKey: null,
  mentionedIds: [],
  inPeriod: true,
  ...extra,
});

const detail = (messages: ReplyEvidenceMessage[], opts: Partial<ReplyAttributionOptions> = {}) =>
  computeReplyAttribution(messages, { ...OPTS, detailGroupKey: G, ...opts });
const askOf = (result: ReturnType<typeof detail>, customerKey: string) => result.asksDetail!.find((a) => a.customerKey === customerKey)!;

describe("computeReplyAttribution", () => {
  it("quote of a customer's line links Tier1 and closes that customer's ask only", () => {
    const a = customer(0, [A]);
    const b = customer(1, [B]);
    const r = reply(5, { quotedKey: a.key });
    const result = detail([a, b, r]);
    expect(askOf(result, A)).toMatchObject({ tier: "TIER1_QUOTE", answeredAt: min(5), answeredBy: { actor: "MEMBER", memberId: "rina" } });
    expect(askOf(result, B)).toMatchObject({ tier: null, answeredAt: null });
    // B, whom nobody answered, is past its threshold by the time of measuring.
    expect(result.asks).toMatchObject({ total: 2, answeredTier1: 1, unanswered: 1, pending: 0 });
    expect(result.replies.byTier.TIER1_QUOTE).toBe(1);
  });

  it("quote of a staff message falls through to the other rules", () => {
    const a = customer(0, [A]);
    const staff = reply(2);
    const r = reply(5, { quotedKey: staff.key });
    const result = detail([a, staff, r]);
    // The staff reply (no quote) answered the lone customer by sequence; the quoting reply then finds nobody waiting.
    expect(askOf(result, A).tier).toBe("TIER2_SEQUENCE");
    expect(result.replies.byTier.TIER1_QUOTE).toBe(0);
    expect(result.replies.unresolvedReasons).toEqual({ NO_OPEN_ASK: 1 });
  });

  it("a quote of an answered customer's line is a follow-up: recorded, nothing reopened, nobody else credited", () => {
    const a = customer(0, [A]);
    const first = reply(3, { quotedKey: a.key });
    const b = customer(4, [B]);
    const again = reply(6, { quotedKey: a.key });
    const result = detail([a, first, b, again]);
    expect(result.replies.byTier.TIER1_QUOTE).toBe(2);
    // B was never linked by the reply that quoted A.
    expect(askOf(result, B)).toMatchObject({ tier: null, answeredAt: null });
    expect(askOf(result, A).answeredAt).toBe(min(3));
  });

  it("a quote of a DIFFERENT customer is not credited to this one", () => {
    const a = customer(0, [A]);
    const b = customer(1, [B]);
    const r = reply(5, { quotedKey: b.key });
    const result = detail([a, b, r]);
    expect(askOf(result, B).tier).toBe("TIER1_QUOTE");
    expect(askOf(result, A)).toMatchObject({ tier: null, answeredAt: null });
  });

  it("single mention of an open customer links Tier2 mention", () => {
    const a = customer(0, [A]);
    const b = customer(1, [B]);
    const r = reply(5, { mentionedIds: [B] });
    const result = detail([a, b, r]);
    expect(askOf(result, B)).toMatchObject({ tier: "TIER2_MENTION", answeredAt: min(5) });
    expect(askOf(result, A).answeredAt).toBeNull();
    expect(result.asks.answeredTier2Mention).toBe(1);
  });

  it("mentions of two open customers are UNRESOLVED (MULTIPLE_MENTIONED)", () => {
    const a = customer(0, [A]);
    const b = customer(1, [B]);
    const r = reply(5, { mentionedIds: [A, B] });
    const result = detail([a, b, r]);
    expect(result.replies.unresolvedReasons).toEqual({ MULTIPLE_MENTIONED: 1 });
    expect(result.replies.byTier.TIER4_UNRESOLVED).toBe(1);
    expect(askOf(result, A).answeredAt).toBeNull();
    expect(askOf(result, B).answeredAt).toBeNull();
  });

  it("a mention of a DIFFERENT customer who is not waiting is never credited to the one who is", () => {
    const b = customer(0, [B]);
    const answeredB = reply(2, { quotedKey: b.key });
    const a = customer(4, [A]);
    const r = reply(6, { mentionedIds: [B] });
    const result = detail([b, answeredB, a, r]);
    expect(askOf(result, A)).toMatchObject({ tier: null, answeredAt: null });
    expect(result.replies.unresolvedReasons).toEqual({ MENTIONED_OTHER_CUSTOMER: 1 });
  });

  it("a mention of staff (nobody who wrote as a customer here) does not stop the sequence rule", () => {
    const a = customer(0, [A]);
    const r = reply(5, { mentionedIds: ["8801000000102"] });
    expect(askOf(detail([a, r]), A).tier).toBe("TIER2_SEQUENCE");
  });

  it("single open ask, no other customer spoke, inside the window → Tier2 sequence", () => {
    const a = customer(0, [A]);
    const a2 = customer(10, [A]);
    const r = reply(30);
    const result = detail([a, a2, r]);
    expect(askOf(result, A)).toMatchObject({ tier: "TIER2_SEQUENCE", askedAt: min(0), answeredAt: min(30) });
    expect(result.asks.answeredTier2Sequence).toBe(1);
    expect(result.customerSpecificWait).toEqual({ medianSeconds: 1800, p90Seconds: 1800, samples: 1 });
  });

  it("another customer spoke in between → UNRESOLVED (OTHER_CUSTOMER_SPOKE)", () => {
    const a = customer(0, [A]);
    const b = customer(5, [B]);
    const closeB = reply(6, { quotedKey: b.key });
    const r = reply(10);
    const result = detail([a, b, closeB, r]);
    expect(result.replies.unresolvedReasons).toEqual({ OTHER_CUSTOMER_SPOKE: 1 });
    expect(askOf(result, A).answeredAt).toBeNull();
  });

  it("several customers waiting → UNRESOLVED (MULTIPLE_OPEN_ASKS); none → NO_OPEN_ASK", () => {
    const result = detail([customer(0, [A]), customer(1, [B]), reply(5), reply(6, { quotedKey: "nothing" })]);
    expect(result.replies.unresolvedReasons).toEqual({ MULTIPLE_OPEN_ASKS: 2 });
    expect(detail([reply(1)]).replies.unresolvedReasons).toEqual({ NO_OPEN_ASK: 1 });
  });

  it("outside the 4h window → UNRESOLVED (OUTSIDE_WINDOW)", () => {
    const a = customer(0, [A]);
    const r = reply(5 * 60);
    const result = detail([a, r]);
    expect(result.replies.unresolvedReasons).toEqual({ OUTSIDE_WINDOW: 1 });
    expect(askOf(result, A).answeredAt).toBeNull();
    // Unanswered by any linked reply, and past its threshold: reported as unanswered, not as missed.
    expect(result.asks.unanswered).toBe(1);
  });

  it("LID and phone copies of one customer are one cluster", () => {
    const first = customer(0, [L, A]); // one message stored under a LID by one number and a phone by the other
    const second = customer(2, [L]);
    const r = reply(5, { mentionedIds: [A] });
    const result = detail([first, second, r]);
    expect(result.asks.total).toBe(1); // a run of lines from one person is one ask
    expect(askOf(result, L).tier).toBe("TIER2_MENTION"); // the cluster key is its smallest id; the phone id matched the cluster
    // Ids are compared exactly: a mention that merely LOOKS like the LID with digits rearranged links nothing.
    const other = detail([customer(0, [L]), reply(5, { mentionedIds: ["100000000030"] })]);
    expect(askOf(other, L).tier).toBe("TIER2_SEQUENCE");
  });

  it("an unresolved reply closes nothing; the legacy group wait is unaffected", () => {
    const a = customer(0, [A]);
    const b = customer(1, [B]);
    const r = reply(8);
    const legacy: ReportMessage[] = [a, b, r].map((m) => ({ groupKey: m.groupKey, ts: m.ts, kind: m.kind, memberId: m.memberId, actor: m.actor }));
    const run = () =>
      computeTeamReport(legacy, {
        rangeStart: OPTS.rangeStart,
        rangeEnd: OPTS.rangeEnd,
        now: OPTS.measuredTo,
        idleGapMs: 120 * 60_000,
        missedAfterMs: () => 30 * 60_000,
        assignedMemberFor: () => null,
        memberId: null,
        scope: null,
        granularity: "day",
        dutyFor: null,
      });
    const before = run();
    const result = detail([a, b, r]);
    // Two customers waiting, one reply, nothing links it: both asks stay open and past the threshold...
    expect(result.replies.byTier.TIER4_UNRESOLVED).toBe(1);
    expect(result.asks).toMatchObject({ answeredTier1: 0, answeredTier2Mention: 0, answeredTier2Sequence: 0, unanswered: 2 });
    // ...while the group's own wait (any reply ends it) is the same with or without this section.
    expect(run()).toEqual(before);
    expect(before.waits).toHaveLength(1);
    expect(before.waits[0]!.repliedAt).toBe(min(8));
  });

  it("broadcast is NOT_A_REPLY and answers nobody", () => {
    const a = customer(0, [A]);
    const bc = reply(3, { actor: "BROADCAST", kind: "BUSINESS", memberId: null });
    const result = detail([a, bc]);
    expect(result.replies.notAReply).toBe(1);
    expect(result.replies.total).toBe(0);
    expect(askOf(result, A).answeredAt).toBeNull();
  });

  it("TIER3_PROBABLE is never produced, and is not a verified tier", () => {
    const scenarios: ReplyEvidenceMessage[][] = [
      [customer(0, [A]), reply(3)],
      [customer(0, [A]), customer(1, [B]), reply(3), reply(4, { mentionedIds: [A] })],
      [customer(0, [A]), reply(300)],
      [reply(1)],
    ];
    for (const s of scenarios) expect(computeReplyAttribution(s, OPTS).replies.byTier.TIER3_PROBABLE).toBe(0);
    expect(VERIFIED_LINK_TIERS.has("TIER3_PROBABLE")).toBe(false);
    expect(VERIFIED_LINK_TIERS.has("TIER4_UNRESOLVED")).toBe(false);
    expect([...VERIFIED_LINK_TIERS].sort()).toEqual(["TIER1_QUOTE", "TIER2_MENTION", "TIER2_SEQUENCE"]);
    expect(REPLY_LINK_TIERS).toContain("TIER3_PROBABLE");
    expect(REPLY_ATTRIBUTION_VERSION).toBe("reply-attribution-1");
  });

  it("a customer line with no sender id is counted apart and contradicts a lone-customer link", () => {
    const a = customer(0, [A]);
    const stranger = customer(2, []);
    const r = reply(5);
    const result = detail([a, stranger, r]);
    expect(result.asks.noCustomerId).toBe(1);
    expect(result.asks.total).toBe(1);
    expect(result.replies.unresolvedReasons).toEqual({ OTHER_CUSTOMER_SPOKE: 1 });
  });

  it("only asks that start inside the period count; a reply after it closes a counted ask (look-ahead)", () => {
    const before = customer(-120, [B], { inPeriod: false });
    const beforeAnswer = reply(-110, { quotedKey: before.key, inPeriod: false });
    const a = customer(10, [A], { ts: OPTS.rangeEnd - 60_000 });
    const late = reply(0, { ts: OPTS.rangeEnd + 5 * 60_000, inPeriod: false });
    const result = computeReplyAttribution([before, beforeAnswer, a, late], { ...OPTS, detailGroupKey: G });
    expect(result.asks.total).toBe(1);
    expect(result.asks.answeredTier2Sequence + result.asks.unanswered + result.asks.pending).toBe(1);
    // The reply is outside the period but answered a counted ask, so it is counted.
    expect(result.replies.total).toBe(1);
  });

  it("per member: verified tiers only, with the asks they answered and their median", () => {
    const a = customer(0, [A]);
    const r1 = reply(10, { quotedKey: a.key, memberId: "rina" });
    const b = customer(20, [B]);
    const r2 = reply(25, { memberId: "rakib" });
    const result = detail([a, r1, b, r2]);
    expect(result.byMember).toEqual([
      { memberId: "rakib", asksAnswered: 1, medianSeconds: 300 },
      { memberId: "rina", asksAnswered: 1, medianSeconds: 600 },
    ]);
    expect(result.byGroup).toEqual([{ groupKey: G, asks: 2, answeredVerified: 2, unanswered: 0, repliesUnresolved: 0 }]);
  });

  it("deterministic: the same input twice is deep-equal, and equal timestamps keep input order", () => {
    const a = customer(0, [A]);
    const b = customer(0, [B]);
    const q1 = reply(5, { quotedKey: a.key, memberId: "first" });
    const q2 = reply(5, { quotedKey: a.key, memberId: "second" });
    const input = [a, b, q1, q2];
    expect(computeReplyAttribution(input, OPTS)).toEqual(computeReplyAttribution(input, OPTS));
    // Both quote A at the same instant: the one first in the Team Report's order answers it.
    expect(askOf(detail(input), A).answeredBy?.memberId).toBe("first");
    expect(askOf(detail([a, b, q2, q1]), A).answeredBy?.memberId).toBe("second");
    // Cluster keys and the output order do not depend on the order ids appear in.
    const swapped = computeReplyAttribution([customer(0, [A, L]), customer(1, [L, A])], OPTS);
    const same = computeReplyAttribution([customer(0, [L, A]), customer(1, [A, L])], OPTS);
    expect(swapped).toEqual(same);
  });

  it("asksDetail only for the group asked about", () => {
    expect(computeReplyAttribution([customer(0, [A])], OPTS).asksDetail).toBeUndefined();
    expect(detail([customer(0, [A])]).asksDetail).toHaveLength(1);
    expect(detail([customer(0, [A], { groupKey: "other@g.us" })]).asksDetail).toEqual([]);
  });
});
