import { describe, expect, it } from "vitest";
import {
  computePersonalReport,
  computeTeamReport,
  type PersonalReportMessage,
  type PersonalReportOptions,
  type ReportMessage,
} from "../index.js";

/**
 * Personal (one-to-one) report counting. Synthetic ids only; no real numbers or text. The conversation is
 * the "group" of the Team Report's own wait, so these also pin that the wait is not re-implemented.
 */

const MIN = 60_000;
const H = 3_600_000;
const START = Date.UTC(2026, 9, 1) - 6 * H; // 1 Oct 2026, Dhaka midnight
const END = START + 24 * H;
const NOW = END + 5 * 24 * H;
const MEASURED_TO = END + 24 * H;

const A = (chat: string) => `acct-A|${chat}`;
const CHAT = "8801000000201@c.us";
const CHAT2 = "8801000000202@c.us";
const CHAT3 = "100000000303@lid";

type Who = "C" | "AI" | "RULE" | "OP" | "OPX" | "PHONE" | "BC";
let seq = 0;
function msg(conversation: string, ts: number, who: Who, over: Partial<PersonalReportMessage> = {}): PersonalReportMessage {
  seq += 1;
  const [accountId, chatId] = conversation.split("|") as [string, string];
  const base = { conversationKey: conversation, accountId, chatId, key: `k${seq}`, ts, operatorUserId: null, sender: chatId.split("@")[0]!, text: null };
  switch (who) {
    case "C":
      return { ...base, kind: "CUSTOMER", actor: "CUSTOMER", memberId: null, ...over };
    case "AI":
      return { ...base, kind: "BUSINESS", actor: "AI", memberId: null, ...over };
    case "RULE":
      return { ...base, kind: "BUSINESS", actor: "RULE", memberId: null, ...over };
    case "OP":
      return { ...base, kind: "MEMBER", actor: "OPERATOR", memberId: "m1", operatorUserId: "u1", ...over };
    case "OPX":
      return { ...base, kind: "BUSINESS", actor: "OPERATOR", memberId: null, operatorUserId: "u2", ...over };
    case "PHONE":
      return { ...base, kind: "BUSINESS", actor: "BUSINESS_PHONE", memberId: null, ...over };
    case "BC":
      return { ...base, kind: "BUSINESS", actor: "BROADCAST", memberId: null, ...over };
  }
}

const options = (over: Partial<PersonalReportOptions> = {}): PersonalReportOptions => ({
  rangeStart: START,
  rangeEnd: END,
  now: NOW,
  measuredTo: MEASURED_TO,
  missedAfterMs: 30 * MIN,
  granularity: "day",
  scope: null,
  excluded: new Map(),
  earlierMessageAt: new Map(),
  ...over,
});

const at = (offsetMs: number) => START + offsetMs;

describe("computePersonalReport", () => {
  it("a run of customer lines is one wait", () => {
    const r = computePersonalReport(
      [msg(A(CHAT), at(1 * H), "C"), msg(A(CHAT), at(1 * H + MIN), "C"), msg(A(CHAT), at(1 * H + 2 * MIN), "C"), msg(A(CHAT), at(1 * H + 10 * MIN), "OP")],
      options(),
    );
    expect(r.summary.customerMessages).toBe(3);
    expect(r.summary.waits).toBe(1);
    expect(r.waits[0]).toMatchObject({ groupKey: A(CHAT), waitSeconds: 600, status: "ON_TIME", repliedBy: "m1" });
  });

  it("any reply closes the observed wait", () => {
    const r = computePersonalReport(
      [msg(A(CHAT), at(1 * H), "C"), msg(A(CHAT), at(1 * H + 5 * MIN), "PHONE"), msg(A(CHAT2), at(2 * H), "C"), msg(A(CHAT2), at(2 * H + 5 * MIN), "AI")],
      options(),
    );
    expect(r.waits.map((w) => [w.status, w.repliedBy])).toEqual([
      ["ON_TIME", "BUSINESS"],
      ["ON_TIME", "BUSINESS"],
    ]);
    expect(r.summary.verifiedEmployeeReplies).toBe(0);
    expect(r.summary.businessPhoneReplies).toBe(1);
    expect(r.summary.automatedReplies).toEqual({ ai: 1, rule: 0 });
    expect(r.response.firstReplyBy.OTHER_BUSINESS_REPLY).toBe(1);
    expect(r.response.firstReplyBy.AUTOMATED_AI).toBe(1);
  });

  it("AI reply closes observed wait but not the human wait", () => {
    const r = computePersonalReport(
      [msg(A(CHAT), at(1 * H), "C"), msg(A(CHAT), at(1 * H + MIN), "AI"), msg(A(CHAT), at(1 * H + 40 * MIN), "OP")],
      options(),
    );
    // Observed: the AI answered a minute later.
    expect(r.waits[0]).toMatchObject({ waitSeconds: 60, status: "ON_TIME", repliedByActor: "AI" });
    // Human: only the person's reply ended it, 40 minutes after the question, after the AI had answered.
    expect(r.humanWaits).toHaveLength(1);
    expect(r.humanWaits[0]).toMatchObject({ waitSeconds: 2400, status: "LATE", automatedFirstActor: "AI" });
    expect(r.response.human.afterAutomation).toBe(1);
    expect(r.employeeAnsweredHumanWaits).toBe(1);
  });

  it("closing remark opens no human wait", () => {
    const r = computePersonalReport(
      [
        msg(A(CHAT), at(1 * H), "C", { text: "how do i pay?" }),
        msg(A(CHAT), at(1 * H + 5 * MIN), "OP"),
        msg(A(CHAT), at(2 * H), "C", { text: "thanks" }),
      ],
      options(),
    );
    // The Team Report's wait does start on a closing remark; Human Response SLA's does not.
    expect(r.waits).toHaveLength(2);
    expect(r.humanWaits).toHaveLength(1);
    expect(r.humanWaits[0]!.askedAt).toBe(at(1 * H));
  });

  it("only OPERATOR with memberId counts as verified employee reply", () => {
    const r = computePersonalReport(
      [
        msg(A(CHAT), at(1 * H), "C"),
        msg(A(CHAT), at(1 * H + MIN), "OP"),
        msg(A(CHAT), at(1 * H + 2 * MIN), "OPX"),
        msg(A(CHAT), at(1 * H + 3 * MIN), "PHONE"),
        msg(A(CHAT), at(1 * H + 4 * MIN), "AI"),
        msg(A(CHAT), at(1 * H + 5 * MIN), "RULE"),
        msg(A(CHAT), at(1 * H + 6 * MIN), "BC"),
      ],
      options(),
    );
    expect(r.summary.verifiedEmployeeReplies).toBe(1);
    expect(r.summary.businessReplies).toBe(6);
    expect(r.summary.automatedReplies).toEqual({ ai: 1, rule: 1 });
    expect(r.summary.businessPhoneReplies).toBe(1);
    expect(r.summary.broadcastMessages).toBe(1);
    expect(r.conversations[0]).toMatchObject({ verifiedEmployeeReplies: 1, businessReplies: 6, automatedReplies: 2, employeeIds: ["m1"] });
    expect(r.members).toEqual([{ memberId: "m1", verifiedReplies: 1, conversations: 1, humanWaitsAnswered: 1, medianSeconds: 60 }]);
  });

  it("unlinked operator is a verified human but not employee-credited", () => {
    const r = computePersonalReport([msg(A(CHAT), at(1 * H), "C"), msg(A(CHAT), at(1 * H + 5 * MIN), "OPX")], options());
    expect(r.humanWaits[0]!.repliedBy).toMatchObject({ actor: "OPERATOR", memberId: null });
    expect(r.response.human.answeredVerified).toBe(1);
    expect(r.employeeAnsweredHumanWaits).toBe(0);
    expect(r.summary.unlinkedOperatorReplies).toBe(1);
    expect(r.summary.verifiedEmployeeReplies).toBe(0);
    expect(r.members).toEqual([]);
  });

  it("own-number and internal conversations are excluded and counted", () => {
    const r = computePersonalReport(
      [
        msg(A(CHAT), at(1 * H), "C"),
        msg(A(CHAT2), at(1 * H), "C"),
        msg(A(CHAT2), at(1 * H + MIN), "C"),
        msg(A(CHAT3), at(1 * H), "C"),
        msg(A(CHAT3), at(1 * H + 5 * MIN), "OP"),
      ],
      options({
        excluded: new Map([
          [A(CHAT2), "OWN_NUMBER"],
          [A(CHAT3), "INTERNAL"],
        ]),
      }),
    );
    expect(r.summary.conversations).toBe(1);
    expect(r.summary.customerMessages).toBe(1);
    expect(r.summary.verifiedEmployeeReplies).toBe(0);
    expect(r.summary.excluded).toEqual({ ownNumber: 1, internal: 1 });
    expect(r.waits.map((w) => w.groupKey)).toEqual([A(CHAT)]);
    expect(r.conversations.map((c) => c.conversationKey)).toEqual([A(CHAT)]);
  });

  it("same customer on two accounts is two conversations", () => {
    const r = computePersonalReport(
      [msg("acct-A|" + CHAT, at(1 * H), "C"), msg("acct-B|" + CHAT, at(1 * H + MIN), "C"), msg("acct-B|" + CHAT, at(1 * H + 5 * MIN), "OP")],
      options(),
    );
    expect(r.summary.conversations).toBe(2);
    expect(r.summary.waits).toBe(2);
    expect(r.summary.waitingConversations).toBe(1);
    expect(new Set(r.conversations.map((c) => c.accountId))).toEqual(new Set(["acct-A", "acct-B"]));
  });

  it("context messages are never counted; look-ahead replies close period waits", () => {
    const r = computePersonalReport(
      [
        // Context: a wait already open before the period; the period's first line continues it.
        msg(A(CHAT), at(-30 * MIN), "C"),
        msg(A(CHAT), at(10 * MIN), "C"),
        msg(A(CHAT), at(1 * H), "OP"),
        // A wait that starts in the period and is answered after it ended.
        msg(A(CHAT), END - 10 * MIN, "C"),
        msg(A(CHAT), END + 20 * MIN, "OP"),
        // Look-ahead customer line: not this period's.
        msg(A(CHAT), END + 2 * H, "C"),
      ],
      options(),
    );
    expect(r.summary.customerMessages).toBe(2); // the context line and the look-ahead line are not counted
    expect(r.summary.businessReplies).toBe(1); // the look-ahead reply is not counted either
    expect(r.summary.waits).toBe(1);
    expect(r.waits[0]).toMatchObject({ askedAt: END - 10 * MIN, repliedAt: END + 20 * MIN, waitSeconds: 1800, status: "ON_TIME" });
  });

  it("a conversation read only as context or look-ahead is not one of the period's", () => {
    const r = computePersonalReport(
      [msg(A(CHAT), at(1 * H), "C"), msg(A(CHAT2), at(-1 * H), "C"), msg(A(CHAT3), END + 1 * H, "C")],
      options(),
    );
    expect(r.summary).toMatchObject({ conversations: 1, customerConversations: 1, customerMessages: 1, waitingConversations: 1 });
    expect(r.conversations.map((c) => c.chatId)).toEqual([CHAT]);
  });

  it("missed uses missedReplyAfterMinutes; nobody is charged", () => {
    const messages = [
      msg(A(CHAT), at(1 * H), "C"),
      msg(A(CHAT), at(1 * H + 50 * MIN), "OP"),
      msg(A(CHAT), at(5 * H), "C"),
    ];
    const strict = computePersonalReport(messages, options({ missedAfterMs: 30 * MIN }));
    expect(strict.waits.map((w) => [w.status, w.thresholdSeconds, w.chargedTo])).toEqual([
      ["RECALLED", 1800, null],
      ["MISSED", 1800, null],
    ]);
    expect(strict.summary).toMatchObject({ missed: 2, recalled: 1, unrecovered: 1, pending: 0 });
    const lenient = computePersonalReport(messages, options({ missedAfterMs: 90 * MIN }));
    expect(lenient.waits.map((w) => [w.status, w.thresholdSeconds, w.chargedTo])).toEqual([
      ["ON_TIME", 5400, null],
      ["MISSED", 5400, null],
    ]);
    expect(lenient.summary).toMatchObject({ missed: 1, recalled: 0, unrecovered: 1 });
    expect(lenient.conversations[0]).toMatchObject({ waits: 2, missed: 1, unrecovered: 1 });
  });

  it("waitingConversations = latest message is customer at measuredTo", () => {
    const r = computePersonalReport(
      [
        msg(A(CHAT), at(1 * H), "C"), // latest is the customer: waiting
        msg(A(CHAT2), at(1 * H), "C"),
        msg(A(CHAT2), at(1 * H + 5 * MIN), "OP"), // answered: not waiting
        msg(A(CHAT3), at(1 * H), "C"),
        msg(A(CHAT3), at(1 * H + 5 * MIN), "AI"),
        msg(A(CHAT3), MEASURED_TO + H, "C"), // after measuredTo: not yet said
      ],
      options(),
    );
    expect(r.summary.waitingConversations).toBe(1);
    expect(Object.fromEntries(r.conversations.map((c) => [c.chatId, c.waiting]))).toEqual({ [CHAT]: true, [CHAT2]: false, [CHAT3]: false });
  });

  it("member scope narrows employee replies and conversations", () => {
    const messages = [
      msg(A(CHAT), at(1 * H), "C"),
      msg(A(CHAT), at(1 * H + MIN), "OP", { memberId: "m1" }),
      msg(A(CHAT2), at(2 * H), "C"),
      msg(A(CHAT2), at(2 * H + MIN), "OP", { memberId: "m2" }),
      msg(A(CHAT3), at(3 * H), "C"), // answered by nobody credited
      msg(A(CHAT3), at(3 * H + MIN), "AI"),
    ];
    const all = computePersonalReport(messages, options());
    expect(all.summary).toMatchObject({ conversations: 3, customerMessages: 3, verifiedEmployeeReplies: 2 });
    const m1 = computePersonalReport(messages, options({ scope: (id) => id === "m1" }));
    expect(m1.summary).toMatchObject({ conversations: 1, customerMessages: 1, verifiedEmployeeReplies: 1, waits: 1 });
    expect(m1.conversations.map((c) => c.chatId)).toEqual([CHAT]);
    expect(m1.members.map((m) => m.memberId)).toEqual(["m1"]);
    expect(m1.employeeAnsweredHumanWaits).toBe(1);
    // A scope that asks "who, at that moment": a reply sent after the member left the Team is not theirs.
    const early = computePersonalReport(messages, options({ scope: (id, ts) => id === "m1" && ts < at(1 * H) }));
    expect(early.summary.conversations).toBe(0);
    expect(early.summary.verifiedEmployeeReplies).toBe(0);
  });

  it("computeTeamReport is called unchanged", () => {
    const messages = [
      msg(A(CHAT), at(-30 * MIN), "C"),
      msg(A(CHAT), at(10 * MIN), "C"),
      msg(A(CHAT), at(1 * H), "OP"),
      msg(A(CHAT), at(2 * H), "C"),
      msg(A(CHAT), at(2 * H + 40 * MIN), "AI"),
      msg(A(CHAT2), at(3 * H), "C"),
      msg(A(CHAT2), END - 10 * MIN, "C"),
      msg(A(CHAT2), END + 20 * MIN, "PHONE"),
      msg("acct-B|" + CHAT, at(4 * H), "C"),
    ];
    const mapped: ReportMessage[] = messages.map((m) => ({ groupKey: m.conversationKey, ts: m.ts, kind: m.kind, memberId: m.memberId, actor: m.actor }));
    const direct = computeTeamReport(mapped, {
      rangeStart: START,
      rangeEnd: END,
      now: NOW,
      idleGapMs: 30 * MIN,
      missedAfterMs: () => 30 * MIN,
      assignedMemberFor: () => null,
      memberId: null,
      scope: null,
      granularity: "day",
      dutyFor: null,
    });
    const r = computePersonalReport(messages, options());
    expect(r.waits).toEqual(direct.waits);
    expect(r.summary).toMatchObject({
      waits: direct.summary.waits,
      missed: direct.summary.missed,
      recalled: direct.summary.recalled,
      unrecovered: direct.summary.unrecovered,
      customerMessages: direct.summary.customerMessages,
    });
    expect(r.buckets.reduce((sum, b) => sum + b.customerMessages, 0)).toBe(direct.summary.customerMessages);
    expect(r.buckets.reduce((sum, b) => sum + b.waits, 0)).toBe(direct.summary.waits);
    expect(r.buckets.reduce((sum, b) => sum + b.missed, 0)).toBe(direct.summary.missed);
  });

  it("a conversation is new only when nothing earlier was ever stored", () => {
    const r = computePersonalReport(
      [
        msg(A(CHAT), at(1 * H), "C"), // nothing earlier: new
        msg(A(CHAT2), at(-3 * H), "C"), // a context row
        msg(A(CHAT2), at(1 * H), "C"),
        msg(A(CHAT3), at(1 * H), "C"), // the loader's probe found an older message
      ],
      options({ earlierMessageAt: new Map([[A(CHAT3), START - 40 * H]]) }),
    );
    expect(Object.fromEntries(r.conversations.map((c) => [c.chatId, c.isNew]))).toEqual({ [CHAT]: true, [CHAT2]: false, [CHAT3]: false });
    expect(r.summary.newConversations).toBe(1);
  });

  it("buckets split the period and add up to the summary", () => {
    const r = computePersonalReport(
      [msg(A(CHAT), at(1 * H), "C"), msg(A(CHAT), at(1 * H + MIN), "OP"), msg(A(CHAT), at(25 * H), "C")],
      options({ rangeEnd: START + 48 * H }),
    );
    expect(r.buckets.map((b) => [b.customerMessages, b.verifiedEmployeeReplies, b.waits])).toEqual([
      [1, 1, 1],
      [1, 0, 1],
    ]);
  });

  it("is deterministic and orders by customer messages, then key", () => {
    const messages = [
      msg(A(CHAT2), at(1 * H), "C"),
      msg(A(CHAT), at(1 * H), "C"),
      msg(A(CHAT), at(1 * H + MIN), "C"),
      msg(A(CHAT3), at(1 * H), "C"),
      msg(A(CHAT3), at(1 * H + MIN), "OP"),
    ];
    const first = computePersonalReport(messages, options());
    expect(computePersonalReport(messages, options())).toEqual(first);
    // CHAT has two customer messages; the other two tie on one and fall back to the key ("1000..." sorts before "8801...").
    expect(first.conversations.map((c) => c.chatId)).toEqual([CHAT, CHAT3, CHAT2]);
  });

  it("an empty period is empty, not an error", () => {
    const r = computePersonalReport([], options());
    expect(r.summary).toMatchObject({ conversations: 0, customerMessages: 0, waits: 0, waitingConversations: 0 });
    expect(r.conversations).toEqual([]);
    expect(r.response.firstResponse.waits).toBe(0);
  });
});

