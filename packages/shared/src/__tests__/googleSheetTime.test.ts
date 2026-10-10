import { describe, expect, it } from "vitest";
import {
  clampInactivityMinutes,
  clipIntervals,
  computeSheetTime,
  isLive,
  msByDhakaDay,
  stretchesFromSignals,
  unionIntervals,
  type SessionSignal,
  type SessionSignalKind,
} from "../googleSheetTime.js";
import { computeEmployeeReport, computeSheetReport, type ReportActivity } from "../googleSheetReports.js";

/**
 * Google Sheets Phase 7 — work time and viewing time (GOOGLE_SHEETS.md §7), and the reports built on
 * it (Phases 9–10). Times are minutes after 09:00 Dhaka on 9 Oct 2026 (03:00 UTC).
 */

const T0 = Date.UTC(2026, 9, 9, 3, 0, 0);
const at = (minute: number) => new Date(T0 + minute * 60_000);
const MIN = 60_000;

function signals(sessionId: string, userId: string, spreadsheetId: string, list: Array<[number, SessionSignalKind]>): SessionSignal[] {
  return list.map(([m, kind]) => ({ sessionId, userId, spreadsheetId, kind, at: at(m) }));
}
const period = { inactivityMinutes: 5, from: at(-600), to: at(600) };

describe("stretches", () => {
  it("joins signals at most T apart; a longer gap is a pause; a lone signal is zero", () => {
    expect(stretchesFromSignals([0, 2, 4, 20, 21].map((m) => m * MIN), 5 * MIN)).toEqual([
      { start: 0, end: 4 * MIN },
      { start: 20 * MIN, end: 21 * MIN },
    ]);
    expect(stretchesFromSignals([7 * MIN], 5 * MIN)).toEqual([]);
    expect(stretchesFromSignals([], 5 * MIN)).toEqual([]);
  });
  it("unions and clips", () => {
    expect(unionIntervals([{ start: 5, end: 10 }, { start: 0, end: 6 }, { start: 20, end: 30 }, { start: 30, end: 31 }])).toEqual([
      { start: 0, end: 10 },
      { start: 20, end: 31 },
    ]);
    expect(clipIntervals([{ start: 0, end: 10 }, { start: 20, end: 30 }], 5, 25)).toEqual([
      { start: 5, end: 10 },
      { start: 20, end: 25 },
    ]);
  });
  it("keeps the threshold between 1 and 60 minutes", () => {
    expect(clampInactivityMinutes(0)).toBe(1);
    expect(clampInactivityMinutes(90)).toBe(60);
    expect(clampInactivityMinutes("7")).toBe(7);
    expect(clampInactivityMinutes("x")).toBe(5);
  });
});

describe("computeSheetTime", () => {
  it("is not first-open-to-last-close: lunch is not work, and an untouched tab counts nothing", () => {
    // Open 09:00, edit 09:00–09:20, away 09:20–10:10 (tab still open), edit again 10:10–10:30, close 12:00.
    const s = signals("s1", "rudra", "sheet", [
      [0, "START"],
      [0, "WORK_SIGNAL"],
      [10, "WORK_SIGNAL"],
      [20, "WORK_SIGNAL"],
      [70, "WORK_SIGNAL"],
      [80, "WORK_SIGNAL"],
      [90, "WORK_SIGNAL"],
      [180, "CLOSE"],
    ]);
    // Signals 10 minutes apart with T = 5: every gap is a pause. Nothing is invented.
    expect(computeSheetTime(s, period).get("rudra")!.workMs).toBe(0);
    // With T = 15 the two stretches count, and the 50-minute lunch does not.
    const t15 = computeSheetTime(s, { ...period, inactivityMinutes: 15 }).get("rudra")!;
    expect(t15.workMs).toBe(40 * MIN);
    expect(t15.viewingMs).toBe(0);
  });

  it("viewing = presence − work; a monitor-like viewer has viewing only", () => {
    const s = [
      ...signals("w", "borhan", "sheet", [
        [0, "START"],
        [1, "VIEW_SIGNAL"],
        [2, "WORK_SIGNAL"],
        [3, "WORK_SIGNAL"],
        [4, "VIEW_SIGNAL"],
      ]),
      ...signals("v", "cto", "sheet", [
        [0, "START"],
        [3, "VIEW_SIGNAL"],
        [6, "VIEW_SIGNAL"],
      ]),
    ];
    const t = computeSheetTime(s, period);
    expect(t.get("borhan")).toMatchObject({ workMs: 1 * MIN, presenceMs: 4 * MIN, viewingMs: 3 * MIN });
    expect(t.get("cto")).toMatchObject({ workMs: 0, viewingMs: 6 * MIN });
  });

  it("two sheets open at once is one person working once (union, never a sum)", () => {
    const s = [
      ...signals("a", "istiyak", "sheetA", [
        [0, "WORK_SIGNAL"],
        [3, "WORK_SIGNAL"],
        [6, "WORK_SIGNAL"],
      ]),
      ...signals("b", "istiyak", "sheetB", [
        [2, "WORK_SIGNAL"],
        [5, "WORK_SIGNAL"],
        [8, "WORK_SIGNAL"],
      ]),
    ];
    expect(computeSheetTime(s, period).get("istiyak")!.workMs).toBe(8 * MIN);
    // Per sheet, each is its own union.
    expect(computeSheetTime(s, { ...period, spreadsheetId: "sheetA" }).get("istiyak")!.workMs).toBe(6 * MIN);
    expect(computeSheetTime(s, { ...period, spreadsheetId: "sheetB" }).get("istiyak")!.workMs).toBe(6 * MIN);
  });

  it("gaps are measured inside a session, never across two sessions", () => {
    const s = [...signals("x", "khairul", "sheet", [[0, "WORK_SIGNAL"]]), ...signals("y", "khairul", "sheet", [[2, "WORK_SIGNAL"]])];
    expect(computeSheetTime(s, period).get("khairul")!.workMs).toBe(0);
  });

  it("clips a stretch to the period", () => {
    const s = signals("x", "rudra", "sheet", [
      [0, "WORK_SIGNAL"],
      [4, "WORK_SIGNAL"],
      [8, "WORK_SIGNAL"],
    ]);
    expect(computeSheetTime(s, { inactivityMinutes: 5, from: at(2), to: at(6) }).get("rudra")!.workMs).toBe(4 * MIN);
  });

  it("splits time at Dhaka midnight, not UTC midnight", () => {
    const dhakaMidnight = Date.UTC(2026, 9, 9, 18, 0, 0);
    const days = msByDhakaDay([{ start: dhakaMidnight - 10 * MIN, end: dhakaMidnight + 20 * MIN }]);
    expect(Object.fromEntries(days)).toEqual({ "2026-10-09": 10 * MIN, "2026-10-10": 20 * MIN });
  });

  it("a session is live while its last signal is within the threshold", () => {
    expect(isLive(at(0), at(5), 5)).toBe(true);
    expect(isLive(at(0), at(6), 5)).toBe(false);
  });
});

describe("the reports (GOOGLE_SHEETS.md §7 example)", () => {
  const followup = "followup";
  const other = "other";
  const s = [
    // Rudra (Lead): 0–12 on the follow-up sheet, and 5–9 on another sheet at the same time.
    ...signals("r1", "rudra", followup, [
      [0, "START"],
      [0, "WORK_SIGNAL"],
      [4, "WORK_SIGNAL"],
      [8, "WORK_SIGNAL"],
      [12, "WORK_SIGNAL"],
      [14, "VIEW_SIGNAL"],
    ]),
    ...signals("r2", "rudra", other, [
      [5, "WORK_SIGNAL"],
      [9, "WORK_SIGNAL"],
    ]),
    // Borhan (Editor): 0–10.
    ...signals("b1", "borhan", followup, [
      [0, "WORK_SIGNAL"],
      [5, "WORK_SIGNAL"],
      [10, "WORK_SIGNAL"],
    ]),
    // CTO (Monitor): views only.
    ...signals("c1", "cto", followup, [
      [0, "START"],
      [4, "VIEW_SIGNAL"],
      [8, "VIEW_SIGNAL"],
    ]),
  ];
  const activity = (userId: string | null, spreadsheetId: string, over: Partial<ReportActivity>): ReportActivity => ({
    userId,
    spreadsheetId,
    kind: "WORK",
    source: "APPLICATION",
    attribution: "APPLICATION",
    actionType: "CELLS_EDITED",
    itemCount: 3,
    occurredAt: at(4),
    ...over,
  });
  const activities: ReportActivity[] = [
    activity("rudra", followup, {}),
    activity("rudra", followup, { actionType: "ROWS_ADDED", itemCount: 1 }),
    activity("borhan", followup, { itemCount: 7 }),
    activity("borhan", followup, { source: "EXTERNAL_GOOGLE", attribution: "ATTRIBUTED", actionType: "EXTERNAL_EDIT", itemCount: null }),
    activity(null, followup, { source: "EXTERNAL_GOOGLE", attribution: "UNATTRIBUTED", actionType: "EXTERNAL_EDIT", itemCount: null }),
    // Google's record of Rudra's own app save: never counted again.
    activity(null, followup, { source: "EXTERNAL_GOOGLE", attribution: "APPLICATION_ECHO", actionType: "EXTERNAL_EDIT", itemCount: null }),
    // A comment in Google is not an edit.
    activity(null, followup, { source: "EXTERNAL_GOOGLE", attribution: "UNATTRIBUTED", kind: "OTHER", actionType: "EXTERNAL_COMMENT", itemCount: null }),
    // Viewing is never a change.
    activity("cto", followup, { kind: "VIEW", actionType: "SPREADSHEET_OPENED", itemCount: null }),
    // Outside the period.
    activity("borhan", followup, { occurredAt: at(-700) }),
  ];
  const input = { signals: s, activities, ...period };

  it("per employee: unioned time, app changes, cells and credited Google edits", () => {
    const report = computeEmployeeReport(input);
    const rudra = report.rows.find((r) => r.userId === "rudra")!;
    expect(rudra).toMatchObject({ workMs: 12 * MIN, viewingMs: 2 * MIN, appChanges: 2, cellsChanged: 3, externalEdits: 0, sheetsWorked: 2 });
    const borhan = report.rows.find((r) => r.userId === "borhan")!;
    expect(borhan).toMatchObject({ workMs: 10 * MIN, appChanges: 1, cellsChanged: 7, externalEdits: 1 });
    const cto = report.rows.find((r) => r.userId === "cto")!;
    expect(cto).toMatchObject({ workMs: 0, viewingMs: 8 * MIN, appChanges: 0, sheetsWorked: 0 });
    expect(report.unattributedExternalEdits).toBe(1);
    expect(report.totals.workMs).toBe(22 * MIN);
    expect(rudra.byDay).toEqual([{ day: "2026-10-09", workMs: 12 * MIN, viewingMs: 2 * MIN }]);
    expect(rudra.bySheet.map((x) => [x.spreadsheetId, x.workMs])).toEqual([
      [followup, 12 * MIN],
      [other, 4 * MIN],
    ]);
  });

  it("per sheet: each member's own time on it, summed; unattributed edits on their own line", () => {
    const sheets = computeSheetReport(input);
    const sheet = sheets.find((x) => x.spreadsheetId === followup)!;
    expect(sheet.members.map((m) => [m.userId, m.workMs / MIN, m.viewingMs / MIN, m.appChanges, m.externalEdits])).toEqual([
      ["rudra", 12, 2, 2, 0],
      ["borhan", 10, 0, 1, 1],
      ["cto", 0, 8, 0, 0],
    ]);
    expect(sheet.workMs).toBe(22 * MIN);
    expect(sheet.unattributedExternalEdits).toBe(1);
    expect(sheet.externalEdits).toBe(2);
    expect(sheet.people).toBe(3);
  });
});
