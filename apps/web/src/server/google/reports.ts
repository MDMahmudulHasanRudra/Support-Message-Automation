import {
  computeEmployeeReport,
  computeSheetReport,
  getDhakaDayRange,
  getDhakaMonthRange,
  roleAt,
  type EmployeeReport,
  type ReportActivity,
  type SessionSignal,
  type SheetMemberRole,
  type SheetRow,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { getGoogleSheetsSettings } from "@/server/google/settings";

/**
 * The Google Sheets reports (GOOGLE_SHEETS.md §7, Phases 9–10): ONE loader that fetches the evidence
 * — session signals and the activity log — and hands it to the pure model in packages/shared. The
 * page and both exports call this, so a figure on screen and the same figure in a file are one
 * computation. Nothing here stores a derived number.
 */

export const REPORT_PERIODS = ["today", "yesterday", "7d", "30d", "month", "custom"] as const;
export type ReportPeriodKey = (typeof REPORT_PERIODS)[number];
export const MAX_REPORT_DAYS = 92;
const DAY_MS = 24 * 60 * 60 * 1000;

export const PERIOD_LABELS: Record<ReportPeriodKey, string> = {
  today: "Today",
  yesterday: "Yesterday",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  month: "This month",
  custom: "Custom",
};

export interface SheetReportFilters {
  period: ReportPeriodKey;
  from: string | null;
  to: string | null;
  /** Narrow to one person (employee drill-down) or one sheet (sheet drill-down). */
  userId: string | null;
  spreadsheetId: string | null;
  monitoredOnly: boolean;
}

const isDateKey = (v: string | undefined): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

export function parseSheetReportFilters(params: Record<string, string | undefined>): SheetReportFilters {
  return {
    period: (REPORT_PERIODS as readonly string[]).includes(params.period ?? "") ? (params.period as ReportPeriodKey) : "7d",
    from: isDateKey(params.from) ? params.from : null,
    to: isDateKey(params.to) ? params.to : null,
    userId: params.user?.trim() || null,
    spreadsheetId: params.sheet?.trim() || null,
    monitoredOnly: params.monitored === "1",
  };
}

const dhakaMidnight = (key: string) => {
  const d = new Date(`${key}T00:00:00+06:00`);
  return Number.isNaN(d.getTime()) ? null : d;
};

const fmt = (date: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short", year: "numeric" }).format(date);

/** The period as [start, end) instants on Dhaka calendar days, with a label and any note about clamping. */
export function resolveSheetReportRange(filters: SheetReportFilters, now: Date): { start: Date; end: Date; label: string; note: string | null } {
  const today = getDhakaDayRange(now);
  let start: Date;
  let end: Date;
  let note: string | null = null;
  switch (filters.period) {
    case "today":
      ({ start, end } = today);
      break;
    case "yesterday":
      start = new Date(today.start.getTime() - DAY_MS);
      end = today.start;
      break;
    case "30d":
      start = new Date(today.start.getTime() - 29 * DAY_MS);
      end = today.end;
      break;
    case "month":
      ({ start, end } = getDhakaMonthRange(now));
      break;
    case "custom": {
      let from = (filters.from && dhakaMidnight(filters.from)) || today.start;
      let to = (filters.to && dhakaMidnight(filters.to)) || today.start;
      if (to < from) [from, to] = [to, from];
      start = from;
      end = new Date(to.getTime() + DAY_MS);
      if (end.getTime() - start.getTime() > MAX_REPORT_DAYS * DAY_MS) {
        end = new Date(start.getTime() + MAX_REPORT_DAYS * DAY_MS);
        note = `Custom ranges are limited to ${MAX_REPORT_DAYS} days, so this shows the first ${MAX_REPORT_DAYS} days from the start date.`;
      }
      break;
    }
    default:
      start = new Date(today.start.getTime() - 6 * DAY_MS);
      end = today.end;
  }
  const last = new Date(end.getTime() - DAY_MS);
  const label = start.getTime() === last.getTime() ? fmt(start) : `${fmt(start)} – ${fmt(last)}`;
  return { start, end, label, note };
}

export interface ReportPerson {
  name: string;
  username: string;
  /** Their roster member through the login link, as it stands now. */
  teamMemberName: string | null;
}

export interface ReportSheet {
  name: string;
  isMonitored: boolean;
  removed: boolean;
}

export interface SheetReportData {
  range: { start: Date; end: Date; label: string; note: string | null };
  inactivityMinutes: number;
  employees: EmployeeReport;
  sheets: SheetRow[];
  people: Map<string, ReportPerson>;
  sheetInfo: Map<string, ReportSheet>;
  /** A person's role on a sheet at the END of the period (for the member breakdown). */
  roleAtEnd: (spreadsheetId: string, userId: string) => SheetMemberRole | null;
}

/** Fetch the evidence for a period and compute both reports from it. */
export async function loadSheetReport(filters: SheetReportFilters, now: Date = new Date()): Promise<SheetReportData> {
  const range = resolveSheetReportRange(filters, now);
  const { inactivityMinutes } = await getGoogleSheetsSettings();
  const margin = inactivityMinutes * 60_000;
  const sheetWhere = {
    ...(filters.spreadsheetId ? { spreadsheetId: filters.spreadsheetId } : {}),
    ...(filters.monitoredOnly ? { spreadsheet: { isMonitored: true } } : {}),
  };

  // Signals a little either side of the period, so a stretch running across its edges is joined up
  // and then clipped by the model — never cut short at the boundary.
  const events = await prisma.googleSheetWorkSessionEvent.findMany({
    where: {
      at: { gte: new Date(range.start.getTime() - margin), lt: new Date(range.end.getTime() + margin) },
      session: { ...sheetWhere, ...(filters.userId ? { userId: filters.userId } : {}) },
    },
    select: { sessionId: true, kind: true, at: true, session: { select: { userId: true, spreadsheetId: true } } },
  });
  const signals: SessionSignal[] = events.map((e) => ({ sessionId: e.sessionId, kind: e.kind, at: e.at, userId: e.session.userId, spreadsheetId: e.session.spreadsheetId }));

  const activityRows = await prisma.googleSheetActivity.findMany({
    where: {
      occurredAt: { gte: range.start, lt: range.end },
      kind: { not: "VIEW" },
      ...sheetWhere,
      ...(filters.userId ? { userId: filters.userId } : {}),
    },
    select: { userId: true, spreadsheetId: true, kind: true, source: true, attribution: true, actionType: true, itemCount: true, occurredAt: true },
  });
  const activities: ReportActivity[] = activityRows;

  const input = { signals, activities, inactivityMinutes, from: range.start, to: range.end };
  const employees = computeEmployeeReport(input);
  const sheets = computeSheetReport(input);

  const userIds = new Set<string>(employees.rows.map((r) => r.userId));
  const sheetIds = new Set<string>(sheets.map((s) => s.spreadsheetId));
  for (const r of employees.rows) for (const s of r.bySheet) sheetIds.add(s.spreadsheetId);
  const [users, links, sheetRows, periods] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, name: true, username: true } }),
    prisma.internalTeamMember.findMany({ where: { userId: { in: [...userIds] } }, select: { userId: true, name: true } }),
    prisma.googleSpreadsheet.findMany({ where: { id: { in: [...sheetIds] } }, select: { id: true, name: true, isMonitored: true, removedAt: true } }),
    prisma.googleSpreadsheetMember.findMany({ where: { spreadsheetId: { in: [...sheetIds] } }, select: { spreadsheetId: true, userId: true, role: true, startedAt: true, endedAt: true } }),
  ]);
  const linkByUser = new Map(links.map((l) => [l.userId, l.name]));
  const people = new Map(users.map((u) => [u.id, { name: u.name, username: u.username, teamMemberName: linkByUser.get(u.id) ?? null }]));
  const sheetInfo = new Map(sheetRows.map((s) => [s.id, { name: s.name, isMonitored: s.isMonitored, removed: s.removedAt !== null }]));
  const periodsBySheet = new Map<string, typeof periods>();
  for (const p of periods) periodsBySheet.set(p.spreadsheetId, [...(periodsBySheet.get(p.spreadsheetId) ?? []), p]);
  const lastInstant = new Date(Math.min(range.end.getTime(), now.getTime()) - 1);
  const roleAtEnd = (spreadsheetId: string, userId: string) => roleAt(periodsBySheet.get(spreadsheetId) ?? [], userId, lastInstant);

  return { range, inactivityMinutes, employees, sheets, people, sheetInfo, roleAtEnd };
}
