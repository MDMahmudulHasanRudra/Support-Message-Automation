import { describe, expect, it } from "vitest";
import { attentionItems, changeRatio, shortDuration, type AttentionGroupInput } from "../executiveHealth.js";
import type { ReportWait } from "../teamReport.js";

const H = 3_600_000;
const END = Date.UTC(2026, 9, 31, 18, 0); // a period end
const group = (key: string, over: Partial<AttentionGroupInput> = {}): AttentionGroupInput => ({
  groupKey: key,
  messagesInPeriod: 20,
  messagesPreviousPeriod: 20,
  lastActivityAt: END - H,
  ...over,
});
const wait = (key: string, askedHoursBeforeEnd: number, status: ReportWait["status"], waitMinutes: number | null = null): ReportWait => ({
  groupKey: key,
  askedAt: END - askedHoursBeforeEnd * H,
  repliedAt: status === "ON_TIME" || status === "RECALLED" ? END - askedHoursBeforeEnd * H + (waitMinutes ?? 5) * 60_000 : null,
  repliedBy: status === "ON_TIME" || status === "RECALLED" ? "m1" : null,
  waitSeconds: waitMinutes === null ? null : waitMinutes * 60,
  thresholdSeconds: 30 * 60,
  status,
});
const run = (groups: AttentionGroupInput[], waits: ReportWait[] = []) => attentionItems({ groups, waits, measuredTo: END, prolongedSeconds: 2 * 3600 });

describe("attention list", () => {
  it("a healthy group is not listed: this is an exception list, not a ranking", () => {
    expect(run([group("OK")], [wait("OK", 3, "ON_TIME", 5)])).toEqual([]);
  });

  it("unanswered waits: timed from the OLDEST unanswered customer to the period end, prolonged past the threshold", () => {
    const [short] = run([group("A")], [wait("A", 1, "PENDING"), wait("A", 0.5, "PENDING")]);
    expect(short).toMatchObject({ issue: "UNANSWERED", waitingSeconds: 3600 });
    expect(short!.detail).toBe("2 customer waits with no reply, oldest 1h 00m");
    const [long] = run([group("B")], [wait("B", 5, "MISSED")]);
    expect(long).toMatchObject({ issue: "PROLONGED_UNANSWERED", waitingSeconds: 5 * 3600 });
  });

  it("SLA breach: answered after the threshold, the worst late answer as the figure", () => {
    const [item] = run([group("C")], [wait("C", 3, "RECALLED", 48), wait("C", 2, "RECALLED", 35), wait("C", 1, "ON_TIME", 5)]);
    expect(item).toMatchObject({ issue: "SLA_BREACH", waitingSeconds: 48 * 60, detail: "2 answers after the SLA, worst 48m" });
  });

  it("no communication: days since the last activity, or never recorded", () => {
    const [silent] = run([group("D", { messagesInPeriod: 0, lastActivityAt: END - 32 * 24 * H })]);
    expect(silent).toMatchObject({ issue: "NO_COMMUNICATION", detail: "No communication · 32 days since last activity", waitingSeconds: null });
    const [never] = run([group("E", { messagesInPeriod: 0, lastActivityAt: null })]);
    expect(never!.detail).toBe("No communication · never recorded");
  });

  it("declining: half or less of a meaningful previous period; never from zero, never for a silent group", () => {
    expect(run([group("F", { messagesPreviousPeriod: 820, messagesInPeriod: 210 })])[0]).toMatchObject({
      issue: "DECLINING",
      detail: "Activity down 74.4% (820 → 210 messages)",
    });
    expect(run([group("G", { messagesPreviousPeriod: 8, messagesInPeriod: 1 })])).toEqual([]); // too small to call
    expect(run([group("H", { messagesPreviousPeriod: 0, messagesInPeriod: 50 })])).toEqual([]); // nothing before
    expect(run([group("I", { messagesPreviousPeriod: 100, messagesInPeriod: 51 })])).toEqual([]); // not half
    expect(run([group("J", { messagesPreviousPeriod: 100, messagesInPeriod: 0 })])[0]!.issue).toBe("NO_COMMUNICATION");
  });

  it("each group once, under its most urgent issue, with the rest named; urgent first, longest first", () => {
    const items = run(
      [group("SLA"), group("PRO", { messagesPreviousPeriod: 100, messagesInPeriod: 20 }), group("UNA"), group("PRO2"), group("SIL", { messagesInPeriod: 0 })],
      [wait("PRO", 6, "MISSED"), wait("PRO", 7, "RECALLED", 40), wait("PRO2", 9, "MISSED"), wait("UNA", 0.25, "PENDING"), wait("SLA", 4, "RECALLED", 31)],
    );
    expect(items.map((i) => [i.groupKey, i.issue])).toEqual([
      ["PRO2", "PROLONGED_UNANSWERED"],
      ["PRO", "PROLONGED_UNANSWERED"],
      ["UNA", "UNANSWERED"],
      ["SLA", "SLA_BREACH"],
      ["SIL", "NO_COMMUNICATION"],
    ]);
    expect(items[1]!.alsoIssues).toEqual(["SLA_BREACH", "DECLINING"]);
  });
});

describe("change", () => {
  it("is a ratio, and none at all from zero", () => {
    expect(changeRatio(4210, 4820)).toBeCloseTo(0.1449, 3);
    expect(changeRatio(820, 210)).toBeCloseTo(-0.744, 3);
    expect(changeRatio(0, 50)).toBeNull();
  });
  it("short durations", () => {
    expect(shortDuration(48 * 60)).toBe("48m");
    expect(shortDuration(2 * 3600 + 14 * 60)).toBe("2h 14m");
    expect(shortDuration(3 * 86400 + 4 * 3600)).toBe("3d 4h");
  });
});
