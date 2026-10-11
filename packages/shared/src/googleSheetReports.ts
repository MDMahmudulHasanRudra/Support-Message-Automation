import { countsAsExternalEdit, type SheetActionType, type SheetActivityKind, type SheetActivitySource, type SheetAttribution } from "./googleSheetActivity.js";
import { computeSheetTime, msByDhakaDay, type SessionSignal } from "./googleSheetTime.js";

/**
 * Google Sheets, Phases 9–10 — the employee report and the sheet report (GOOGLE_SHEETS.md §7). ONE
 * pure model over the recorded evidence: the page, both exports and the tests call it, so the screen
 * and the file cannot disagree.
 *
 * What each figure is:
 *   - Work / viewing time: `computeSheetTime` over the session signals — unioned per person, so two
 *     sheets open at once is one person working once. A sheet's figure is that person's union ON that
 *     sheet; a sheet's total is the sum over its people (person-hours).
 *   - Changes (app): application WORK activities — exact, credited to the signed-in person.
 *   - Cells changed: the cells those saves wrote.
 *   - Edits in Google: external changes to the sheet, credited only through a verified identity;
 *     everything else is "unattributed". COUNTS ONLY — Google never says how long, so these never
 *     contribute time.
 */

export interface ReportActivity {
  userId: string | null;
  spreadsheetId: string;
  kind: SheetActivityKind;
  source: SheetActivitySource;
  attribution: SheetAttribution;
  actionType: SheetActionType;
  itemCount: number | null;
  occurredAt: Date;
}

export interface ReportInput {
  signals: readonly SessionSignal[];
  activities: readonly ReportActivity[];
  inactivityMinutes: number;
  from: Date;
  to: Date;
}

export interface PersonFigures {
  workMs: number;
  viewingMs: number;
  appChanges: number;
  cellsChanged: number;
  externalEdits: number;
}

const zero = (): PersonFigures => ({ workMs: 0, viewingMs: 0, appChanges: 0, cellsChanged: 0, externalEdits: 0 });

function inPeriod(at: Date, from: Date, to: Date): boolean {
  return at.getTime() >= from.getTime() && at.getTime() < to.getTime();
}

function isAppWork(a: ReportActivity): boolean {
  return a.source === "APPLICATION" && a.kind === "WORK";
}

export interface EmployeeRow extends PersonFigures {
  userId: string;
  /** Sheets this person did any work on in the period (time or a change, in the app or in Google). */
  sheetsWorked: number;
  /** Per Dhaka day: work and viewing. */
  byDay: Array<{ day: string; workMs: number; viewingMs: number }>;
  /** Per sheet: their figures on it. */
  bySheet: Array<{ spreadsheetId: string } & PersonFigures>;
}

export interface EmployeeReport {
  rows: EmployeeRow[];
  totals: PersonFigures;
  /** External edits nobody could be credited with. */
  unattributedExternalEdits: number;
}

/** Per-person figures for the period, with each person's days and sheets. */
export function computeEmployeeReport(input: ReportInput): EmployeeReport {
  const overall = computeSheetTime(input.signals, { inactivityMinutes: input.inactivityMinutes, from: input.from, to: input.to });
  const sheetIds = new Set(input.signals.map((s) => s.spreadsheetId));
  for (const a of input.activities) sheetIds.add(a.spreadsheetId);
  const perSheet = new Map<string, ReturnType<typeof computeSheetTime>>();
  for (const sheetId of sheetIds) {
    perSheet.set(sheetId, computeSheetTime(input.signals, { inactivityMinutes: input.inactivityMinutes, from: input.from, to: input.to, spreadsheetId: sheetId }));
  }

  const people = new Set<string>(overall.keys());
  const periodActivities = input.activities.filter((a) => inPeriod(a.occurredAt, input.from, input.to));
  for (const a of periodActivities) if (a.userId) people.add(a.userId);

  let unattributed = 0;
  for (const a of periodActivities) if (!a.userId && countsAsExternalEdit(a)) unattributed++;

  const rows: EmployeeRow[] = [];
  for (const userId of people) {
    const time = overall.get(userId);
    const figures = zero();
    figures.workMs = time?.workMs ?? 0;
    figures.viewingMs = time?.viewingMs ?? 0;
    const bySheet = new Map<string, PersonFigures>();
    const sheet = (id: string) => {
      let f = bySheet.get(id);
      if (!f) {
        f = zero();
        bySheet.set(id, f);
      }
      return f;
    };
    for (const [sheetId, times] of perSheet) {
      const t = times.get(userId);
      if (t && (t.workMs > 0 || t.viewingMs > 0)) {
        const f = sheet(sheetId);
        f.workMs = t.workMs;
        f.viewingMs = t.viewingMs;
      }
    }
    for (const a of periodActivities) {
      if (a.userId !== userId) continue;
      if (isAppWork(a)) {
        figures.appChanges++;
        sheet(a.spreadsheetId).appChanges++;
        if (a.actionType === "CELLS_EDITED") {
          figures.cellsChanged += a.itemCount ?? 0;
          sheet(a.spreadsheetId).cellsChanged += a.itemCount ?? 0;
        }
      } else if (countsAsExternalEdit(a)) {
        figures.externalEdits++;
        sheet(a.spreadsheetId).externalEdits++;
      }
    }
    const workDays = time ? msByDhakaDay(time.work) : new Map<string, number>();
    const presenceDays = time ? msByDhakaDay(time.presence) : new Map<string, number>();
    const days = [...new Set([...workDays.keys(), ...presenceDays.keys()])].sort();
    const sheets = [...bySheet.entries()].map(([spreadsheetId, f]) => ({ spreadsheetId, ...f }));
    rows.push({
      userId,
      ...figures,
      sheetsWorked: sheets.filter((s) => s.workMs > 0 || s.appChanges > 0 || s.externalEdits > 0).length,
      byDay: days.map((day) => {
        const work = workDays.get(day) ?? 0;
        return { day, workMs: work, viewingMs: Math.max(0, (presenceDays.get(day) ?? 0) - work) };
      }),
      bySheet: sheets.sort((a, b) => b.workMs - a.workMs || b.appChanges - a.appChanges),
    });
  }
  rows.sort((a, b) => b.workMs - a.workMs || b.appChanges - a.appChanges || a.userId.localeCompare(b.userId));
  const totals = zero();
  for (const r of rows) {
    totals.workMs += r.workMs;
    totals.viewingMs += r.viewingMs;
    totals.appChanges += r.appChanges;
    totals.cellsChanged += r.cellsChanged;
    totals.externalEdits += r.externalEdits;
  }
  return { rows, totals, unattributedExternalEdits: unattributed };
}

export interface SheetMemberRow extends PersonFigures {
  userId: string;
}

export interface SheetRow extends PersonFigures {
  spreadsheetId: string;
  /** People who worked or viewed it in the app, or were credited with an edit in Google. */
  people: number;
  /** External edits nobody could be credited with. */
  unattributedExternalEdits: number;
  /** The shared-sheet breakdown (§7 example): one row per person. */
  members: SheetMemberRow[];
}

/**
 * Per-sheet figures, each with its per-person breakdown. A sheet's work time is the SUM of its
 * people's (each person's own union on that sheet): three people working an hour together is three
 * hours of work on that sheet.
 */
export function computeSheetReport(input: ReportInput): SheetRow[] {
  const sheetIds = new Set(input.signals.map((s) => s.spreadsheetId));
  const periodActivities = input.activities.filter((a) => inPeriod(a.occurredAt, input.from, input.to));
  for (const a of periodActivities) sheetIds.add(a.spreadsheetId);
  const out: SheetRow[] = [];
  for (const sheetId of sheetIds) {
    const times = computeSheetTime(input.signals, { inactivityMinutes: input.inactivityMinutes, from: input.from, to: input.to, spreadsheetId: sheetId });
    const members = new Map<string, PersonFigures>();
    const member = (id: string) => {
      let f = members.get(id);
      if (!f) {
        f = zero();
        members.set(id, f);
      }
      return f;
    };
    for (const [userId, t] of times) {
      if (t.workMs === 0 && t.viewingMs === 0) continue;
      const f = member(userId);
      f.workMs = t.workMs;
      f.viewingMs = t.viewingMs;
    }
    let unattributed = 0;
    for (const a of periodActivities) {
      if (a.spreadsheetId !== sheetId) continue;
      if (isAppWork(a) && a.userId) {
        const f = member(a.userId);
        f.appChanges++;
        if (a.actionType === "CELLS_EDITED") f.cellsChanged += a.itemCount ?? 0;
      } else if (countsAsExternalEdit(a)) {
        if (a.userId) member(a.userId).externalEdits++;
        else unattributed++;
      }
    }
    const rows = [...members.entries()]
      .map(([userId, f]) => ({ userId, ...f }))
      .sort((a, b) => b.workMs - a.workMs || b.appChanges - a.appChanges || a.userId.localeCompare(b.userId));
    const total = zero();
    for (const r of rows) {
      total.workMs += r.workMs;
      total.viewingMs += r.viewingMs;
      total.appChanges += r.appChanges;
      total.cellsChanged += r.cellsChanged;
      total.externalEdits += r.externalEdits;
    }
    out.push({ spreadsheetId: sheetId, ...total, externalEdits: total.externalEdits + unattributed, people: rows.length, unattributedExternalEdits: unattributed, members: rows });
  }
  return out.sort((a, b) => b.workMs - a.workMs || b.appChanges - a.appChanges || a.spreadsheetId.localeCompare(b.spreadsheetId));
}
