import { describe, expect, it } from "vitest";
import {
  combineReportSummaries,
  computePersonalReport,
  computeResponseMetrics,
  computeTeamReport,
  humanWaits,
  type CombinedLine,
  type IntelMessage,
  type PersonalReportMessage,
  type ReportMessage,
} from "../index.js";

const MIN = 60_000;
const H = 3_600_000;
const START = Date.UTC(2026, 9, 1) - 6 * H;
const END = START + 24 * H;
const NOW = END + 5 * 24 * H;
const at = (ms: number) => START + ms;

/** The group report side, built the way the loader builds it: the Team Report's own functions. */
function groupSide(messages: ReportMessage[]) {
  const result = computeTeamReport(messages, {
    rangeStart: START,
    rangeEnd: END,
    now: NOW,
    idleGapMs: 120 * MIN,
    missedAfterMs: () => 30 * MIN,
    assignedMemberFor: () => null,
    memberId: null,
    scope: null,
    granularity: "day",
    dutyFor: null,
  });
  const intel: IntelMessage[] = messages.map((m, i) => ({
    key: `g${i}`,
    groupKey: m.groupKey,
    ts: m.ts,
    actor: m.actor ?? "CUSTOMER",
    memberId: m.memberId,
    operatorUserId: null,
    sender: "100000000001",
    senderName: null,
    text: null,
    quotedKey: null,
    quotedMemberId: null,
    mentionedMemberIds: [],
  }));
  const human = humanWaits(intel, { rangeStart: START, rangeEnd: END, measuredTo: END + 24 * H, thresholdMs: () => 30 * MIN });
  return {
    summary: result.summary,
    response: computeResponseMetrics({ waits: result.waits, humanWaits: human }),
    waits: result.waits,
    humanWaits: human,
    groupsWithMessages: result.groups.length,
  };
}

const customer = (groupKey: string, ts: number): ReportMessage => ({ groupKey, ts, kind: "CUSTOMER", memberId: null, actor: "CUSTOMER" });
const member = (groupKey: string, ts: number): ReportMessage => ({ groupKey, ts, kind: "MEMBER", memberId: "m1", actor: "MEMBER" });
const biz = (groupKey: string, ts: number, actor: "AI" | "BUSINESS_PHONE"): ReportMessage => ({ groupKey, ts, kind: "BUSINESS", memberId: null, actor });

let seq = 0;
const pm = (chat: string, ts: number, who: "C" | "OP" | "AI"): PersonalReportMessage => {
  seq += 1;
  const base = { conversationKey: `acct-A|${chat}`, accountId: "acct-A", chatId: chat, key: `p${seq}`, ts, sender: chat.split("@")[0]!, text: null };
  if (who === "C") return { ...base, kind: "CUSTOMER", actor: "CUSTOMER", memberId: null, operatorUserId: null };
  if (who === "AI") return { ...base, kind: "BUSINESS", actor: "AI", memberId: null, operatorUserId: null };
  return { ...base, kind: "MEMBER", actor: "OPERATOR", memberId: "m1", operatorUserId: "u1" };
};
const personalSide = (messages: PersonalReportMessage[]) =>
  computePersonalReport(messages, {
    rangeStart: START,
    rangeEnd: END,
    now: NOW,
    measuredTo: END + 24 * H,
    missedAfterMs: 30 * MIN,
    granularity: "day",
    scope: null,
    excluded: new Map(),
    earlierMessageAt: new Map(),
  });

const G1 = "120000000000000001@g.us";
const G2 = "120000000000000002@g.us";
const CHAT = "8801000000201@c.us";
const CHAT2 = "8801000000202@c.us";

// Group: three waits of 10 minutes each, answered by a member twice and by the AI once.
const GROUP = () =>
  groupSide([
    customer(G1, at(1 * H)),
    member(G1, at(1 * H + 10 * MIN)),
    customer(G1, at(3 * H)),
    member(G1, at(3 * H + 10 * MIN)),
    customer(G2, at(5 * H)),
    biz(G2, at(5 * H + 10 * MIN), "AI"),
  ]);
// Personal: one wait answered 100 minutes later by a linked dashboard reply (late), one never answered.
const PERSONAL = () =>
  personalSide([pm(CHAT, at(1 * H), "C"), pm(CHAT, at(1 * H + 100 * MIN), "OP"), pm(CHAT2, at(2 * H), "C")]);

const find = (lines: CombinedLine[], label: string) => {
  const line = lines.find((l) => l.label === label);
  if (!line) throw new Error(`no line "${label}"`);
  return line;
};

describe("combineReportSummaries", () => {
  it("additive lines add", () => {
    const group = GROUP();
    const personal = PERSONAL();
    const lines = combineReportSummaries({ group, personal });
    const additive = lines.filter((l) => l.additivity === "ADDITIVE");
    expect(additive.length).toBeGreaterThan(8);
    for (const line of additive) {
      expect(typeof line.group, line.label).toBe("number");
      expect(typeof line.personal, line.label).toBe("number");
      expect(line.combined, line.label).toBe((line.group as number) + (line.personal as number));
    }
    expect(find(lines, "Customer messages")).toMatchObject({ group: 3, personal: 2, combined: 5 });
    expect(find(lines, "Customer waits")).toMatchObject({ group: 3, personal: 2, combined: 5 });
    // Personal: the 100-minute answer is Recall, the unanswered one is never answered.
    expect(find(lines, "Missed")).toMatchObject({ group: 0, personal: 2, combined: 2 });
    expect(find(lines, "Recall support")).toMatchObject({ group: 0, personal: 1, combined: 1 });
    expect(find(lines, "Never answered")).toMatchObject({ group: 0, personal: 1, combined: 1 });
    // A member's own reply (group) and a linked dashboard reply (personal) are both verified employee replies.
    expect(find(lines, "Verified employee replies")).toMatchObject({ group: 2, personal: 1, combined: 3 });
    // The group's business replies (the AI) and the personal ones not credited to a person (none).
    expect(find(lines, "Business number replies")).toMatchObject({ group: 1, personal: 0, combined: 1 });
    expect(find(lines, "First reply came from: Verified person (team member, or a dashboard user)")).toMatchObject({ group: 2, personal: 1, combined: 3 });
    expect(find(lines, "First reply came from: AI")).toMatchObject({ group: 1, personal: 0, combined: 1 });
  });

  it("medians are recomputed over the union, not averaged", () => {
    // Group: three 10-minute waits. Personal: one 100-minute wait. The middle of all four is 10 minutes;
    // the average of the two middles (10 and 100 minutes) would be 55. The human wait is the same shape:
    // the group's two member answers (10 minutes each) and the personal one (100 minutes).
    const lines = combineReportSummaries({ group: GROUP(), personal: PERSONAL() });
    const observed = find(lines, "Median first observed response");
    expect(observed).toMatchObject({ group: "0h 10m", personal: "1h 40m", combined: "0h 10m", additivity: "RECOMPUTED" });
    expect(observed.combined).not.toBe("0h 55m");
    const human = find(lines, "Median first human response");
    expect(human.additivity).toBe("RECOMPUTED");
    expect(human.combined).toBe("0h 10m");
    // The 90th percentile is the nearest rank over the union as well: the slowest of the four.
    expect(find(lines, "90th percentile first observed response")).toMatchObject({ combined: "1h 40m", additivity: "RECOMPUTED" });
  });

  it("an even union takes the middle of the two middle waits", () => {
    const group = groupSide([customer(G1, at(1 * H)), member(G1, at(1 * H + 10 * MIN))]);
    const personal = personalSide([pm(CHAT, at(1 * H), "C"), pm(CHAT, at(1 * H + 30 * MIN), "OP")]);
    // Two waits, 10 and 30 minutes: the median is 20 minutes, which neither report has.
    expect(find(combineReportSummaries({ group, personal }), "Median first observed response").combined).toBe("0h 20m");
  });

  it("distinct customers not offered", () => {
    const lines = combineReportSummaries({ group: GROUP(), personal: PERSONAL() });
    const distinct = find(lines, "Distinct customers");
    expect(distinct).toMatchObject({ group: null, personal: null, combined: null, additivity: "NOT_COMBINABLE" });
    expect(lines.filter((l) => /customers/i.test(l.label) && l.additivity !== "NOT_COMBINABLE" && l.label !== "Customer messages")).toEqual([]);
  });

  it("overtime is GROUP_ONLY", () => {
    const lines = combineReportSummaries({ group: GROUP(), personal: PERSONAL() });
    for (const label of ["Support Overtime", "Support time", "Groups supported", "Active team members"]) {
      const line = find(lines, label);
      expect(line.additivity, label).toBe("GROUP_ONLY");
      expect(line.personal, label).toBeNull();
      expect(line.combined, label).toEqual(line.group);
    }
  });

  it("group-only lines carry the group report's own figures", () => {
    // One member answering across ten hours with gaps under the idle gap: one long stretch, 2 hours past an 8-hour duty.
    const worked = Array.from({ length: 11 }, (_, i) => member(G1, at(i * 60 * MIN)));
    const group = groupSide([customer(G2, at(30 * MIN)), ...worked]);
    expect(group.summary.overtimeSeconds).toBeGreaterThan(0);
    const lines = combineReportSummaries({ group, personal: PERSONAL() });
    expect(find(lines, "Support Overtime")).toMatchObject({ group: "2h 0m", personal: null, combined: "2h 0m" });
    expect(find(lines, "Support time")).toMatchObject({ group: "10h 0m", personal: null });
    expect(find(lines, "Groups supported").group).toBe(group.summary.groupsSupported);
    expect(find(lines, "Active team members").group).toBe(group.summary.activeMembers);
  });

  it("staff the roster cannot name are not verified employee replies", () => {
    const unmapped: ReportMessage = { groupKey: G1, ts: at(2 * H), kind: "MEMBER", memberId: null, actor: "MEMBER_UNMAPPED" };
    const group = groupSide([customer(G1, at(1 * H)), member(G1, at(1 * H + 5 * MIN)), unmapped]);
    expect(group.summary).toMatchObject({ memberReplies: 2, unattributedStaffReplies: 1 });
    const lines = combineReportSummaries({ group, personal: personalSide([]) });
    expect(find(lines, "Verified employee replies")).toMatchObject({ group: 1, personal: 0, combined: 1 });
  });

  it("conversations are added with their different units said", () => {
    const lines = combineReportSummaries({ group: GROUP(), personal: PERSONAL() });
    expect(find(lines, "Conversations")).toMatchObject({ group: 2, personal: 2, combined: 4, additivity: "ADDITIVE_DIFFERENT_UNITS" });
  });

  it("is deterministic and writes every cell as a number, text or nothing", () => {
    const first = combineReportSummaries({ group: GROUP(), personal: PERSONAL() });
    expect(combineReportSummaries({ group: GROUP(), personal: PERSONAL() })).toEqual(first);
    for (const line of first) {
      for (const value of [line.group, line.personal, line.combined]) expect(value === null || typeof value === "number" || typeof value === "string").toBe(true);
      expect(String(line.combined)).not.toMatch(/%/);
    }
  });

  it("an empty personal side changes nothing about the group figures", () => {
    const group = GROUP();
    const lines = combineReportSummaries({ group, personal: personalSide([]) });
    for (const line of lines.filter((l) => l.additivity === "ADDITIVE")) expect(line.combined, line.label).toBe(line.group);
    expect(find(lines, "Median first observed response").combined).toBe(find(lines, "Median first observed response").group);
  });
});
