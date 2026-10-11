import { SHEET_MEMBER_ROLE_LABELS } from "@support-automation/shared";
import type { SheetReportData } from "@/server/google/reports";

/**
 * The report tables (Phases 9–10), built ONCE from `loadSheetReport` for both the page and the
 * exports — so a column, its order and its values are the same on screen and in the file. Durations
 * are milliseconds here; the page shows them as "2h 14m", a file as decimal hours.
 */

export type ColumnKind = "text" | "duration" | "count";
export interface ReportColumn {
  key: string;
  label: string;
  kind: ColumnKind;
}
export type ReportCell = string | number;
/** Where a row opens: one person's breakdown, or one spreadsheet's. The page turns it into a link. */
export type ReportDrill = { view: "employees"; user: string } | { view: "sheets"; sheet: string };
export interface ReportTable {
  columns: ReportColumn[];
  rows: Array<{ id: string; drill?: ReportDrill; cells: Record<string, ReportCell>; emphasis?: "total" | "muted" }>;
}

const FIGURES: ReportColumn[] = [
  { key: "work", label: "Work time", kind: "duration" },
  { key: "viewing", label: "Viewing time", kind: "duration" },
  { key: "changes", label: "Changes (app)", kind: "count" },
  { key: "cells", label: "Cells changed", kind: "count" },
  { key: "external", label: "Edits in Google", kind: "count" },
];

function figures(f: { workMs: number; viewingMs: number; appChanges: number; cellsChanged: number; externalEdits: number }) {
  return { work: f.workMs, viewing: f.viewingMs, changes: f.appChanges, cells: f.cellsChanged, external: f.externalEdits };
}

const personName = (data: SheetReportData, userId: string) => data.people.get(userId)?.name ?? "Unknown login";
const teamName = (data: SheetReportData, userId: string) => data.people.get(userId)?.teamMemberName ?? "—";
const sheetName = (data: SheetReportData, id: string) => data.sheetInfo.get(id)?.name ?? "Unknown spreadsheet";

/** One row per person: the employee report. */
export function employeesTable(data: SheetReportData): ReportTable {
  const t = data.employees.totals;
  return {
    columns: [
      { key: "name", label: "Employee", kind: "text" },
      { key: "team", label: "Team member", kind: "text" },
      ...FIGURES.slice(0, 2),
      { key: "sheets", label: "Spreadsheets worked on", kind: "count" },
      ...FIGURES.slice(2),
    ],
    rows: [
      ...data.employees.rows.map((r) => ({
        id: r.userId,
        drill: { view: "employees" as const, user: r.userId },
        cells: { name: personName(data, r.userId), team: teamName(data, r.userId), sheets: r.sheetsWorked, ...figures(r) },
      })),
      ...(data.employees.unattributedExternalEdits > 0
        ? [
            {
              id: "unattributed",
              emphasis: "muted" as const,
              cells: { name: "Unattributed (edits in Google nobody could be credited with)", team: "—", work: 0, viewing: 0, sheets: 0, changes: 0, cells: 0, external: data.employees.unattributedExternalEdits },
            },
          ]
        : []),
      {
        id: "total",
        emphasis: "total" as const,
        cells: { name: "Total", team: "", sheets: data.sheets.filter((s) => s.workMs > 0 || s.appChanges > 0 || s.externalEdits > 0).length, ...figures(t), external: t.externalEdits + data.employees.unattributedExternalEdits },
      },
    ],
  };
}

/** One person, day by day. */
export function employeeDaysTable(data: SheetReportData, userId: string): ReportTable {
  const row = data.employees.rows.find((r) => r.userId === userId);
  return {
    columns: [
      { key: "day", label: "Day", kind: "text" },
      { key: "work", label: "Work time", kind: "duration" },
      { key: "viewing", label: "Viewing time", kind: "duration" },
    ],
    rows: (row?.byDay ?? []).map((d) => ({ id: d.day, cells: { day: d.day, work: d.workMs, viewing: d.viewingMs } })),
  };
}

/** One person, spreadsheet by spreadsheet. */
export function employeeSheetsTable(data: SheetReportData, userId: string): ReportTable {
  const row = data.employees.rows.find((r) => r.userId === userId);
  return {
    columns: [{ key: "sheet", label: "Spreadsheet", kind: "text" }, { key: "role", label: "Role (end of period)", kind: "text" }, ...FIGURES],
    rows: (row?.bySheet ?? []).map((s) => {
      const role = data.roleAtEnd(s.spreadsheetId, userId);
      return {
        id: s.spreadsheetId,
        drill: { view: "sheets" as const, sheet: s.spreadsheetId },
        cells: { sheet: sheetName(data, s.spreadsheetId), role: role ? SHEET_MEMBER_ROLE_LABELS[role] : "Not a member", ...figures(s) },
      };
    }),
  };
}

/** One row per spreadsheet: the sheet report. A sheet's time is the sum over its people (person-hours). */
export function sheetsTable(data: SheetReportData): ReportTable {
  const total = data.sheets.reduce(
    (acc, s) => ({ workMs: acc.workMs + s.workMs, viewingMs: acc.viewingMs + s.viewingMs, appChanges: acc.appChanges + s.appChanges, cellsChanged: acc.cellsChanged + s.cellsChanged, externalEdits: acc.externalEdits + s.externalEdits }),
    { workMs: 0, viewingMs: 0, appChanges: 0, cellsChanged: 0, externalEdits: 0 },
  );
  return {
    columns: [{ key: "sheet", label: "Spreadsheet", kind: "text" }, { key: "people", label: "People", kind: "count" }, ...FIGURES],
    rows: [
      ...data.sheets.map((s) => ({
        id: s.spreadsheetId,
        drill: { view: "sheets" as const, sheet: s.spreadsheetId },
        cells: { sheet: sheetName(data, s.spreadsheetId), people: s.people, ...figures(s) },
      })),
      { id: "total", emphasis: "total" as const, cells: { sheet: "Total", people: new Set(data.sheets.flatMap((s) => s.members.map((m) => m.userId))).size, ...figures(total) } },
    ],
  };
}

/** One spreadsheet, person by person (GOOGLE_SHEETS.md §7's example), with the unattributed row and the total. */
export function sheetMembersTable(data: SheetReportData, spreadsheetId: string): ReportTable {
  const sheet = data.sheets.find((s) => s.spreadsheetId === spreadsheetId);
  const members = sheet?.members ?? [];
  return {
    columns: [{ key: "name", label: "Member", kind: "text" }, { key: "role", label: "Role (end of period)", kind: "text" }, { key: "team", label: "Team member", kind: "text" }, ...FIGURES],
    rows: [
      ...members.map((m) => {
        const role = data.roleAtEnd(spreadsheetId, m.userId);
        return {
          id: m.userId,
          drill: { view: "employees" as const, user: m.userId },
          cells: { name: personName(data, m.userId), role: role ? SHEET_MEMBER_ROLE_LABELS[role] : "Not a member", team: teamName(data, m.userId), ...figures(m) },
        };
      }),
      ...(sheet && sheet.unattributedExternalEdits > 0
        ? [{ id: "unattributed", emphasis: "muted" as const, cells: { name: "Unattributed", role: "—", team: "—", work: 0, viewing: 0, changes: 0, cells: 0, external: sheet.unattributedExternalEdits } }]
        : []),
      {
        id: "total",
        emphasis: "total" as const,
        cells: { name: "Total", role: "", team: "", ...figures(sheet ?? { workMs: 0, viewingMs: 0, appChanges: 0, cellsChanged: 0, externalEdits: 0 }) },
      },
    ],
  };
}
