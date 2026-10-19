import { DHAKA_OFFSET_MS, formatDhakaDateKey } from "./dhakaDay.js";

/**
 * Support Overtime (TEAM_OVERTIME.md): time a person worked BEYOND their regular duty, per Asia/Dhaka
 * day, summed over a period. Pure, unit-tested, and the only place this is decided — the Team
 * Report's table, chart, exports and every other report read it from `computeTeamReport`.
 *
 *   daily overtime = max(0, worked that day − regular duty that day)
 *   period overtime = Σ daily overtime        (never: total worked − total duty)
 *
 * WORKED is the Team Report's existing support time and nothing more generous: the member's
 * messages split into stretches at the idle gap ("offline after", Team Performance's setting) and at
 * Dhaka midnight, each stretch first-to-last message. A lone message is zero seconds; silence longer
 * than the idle gap is never counted, so a message at 10:00 and one at 22:00 are two moments, not
 * twelve hours. Stretches are per person across every group, so parallel groups are never added twice.
 *
 * Which day a stretch belongs to: the part inside a shift window counts for the day that shift
 * STARTED (01:00 inside a 22:00–06:00 shift is the evening's work), everything else for its own
 * calendar day — exactly as the Duty & Workload report cuts it.
 *
 * REGULAR DUTY is resolved per member per day by `resolveRegularDuty` (priority documented there).
 * It is internal: the report shows overtime only, never a duty length.
 */

/** Where a day's regular duty came from — for data-quality notes, never shown as a duration. */
export type DutySource =
  /** The roster (DutyAssignment) for that date: its own snapshot of the shift times. */
  | "ROSTER"
  /** The member's weekly pattern, unchanged since before that date. */
  | "WEEKLY_PATTERN"
  /** The member's default shift, unchanged since before that date. */
  | "DEFAULT_SHIFT"
  /** A day with no regular duty: off, leave, holiday, or extra duty. All work is overtime. */
  | "NO_DUTY"
  /** Nothing above applies: the project's default duty length. */
  | "FALLBACK";

export interface ResolvedDuty {
  /** Regular duty for the day, seconds. 0 means every second worked that day is overtime. */
  regularSeconds: number;
  /** The shift window, minutes from that day's Dhaka midnight, when one is known. */
  startMinute: number | null;
  endMinute: number | null;
  source: DutySource;
}

export const DEFAULT_OVERTIME_FALLBACK_DUTY_MINUTES = 8 * 60;
export const MIN_FALLBACK_DUTY_MINUTES = 60;
export const MAX_FALLBACK_DUTY_MINUTES = 16 * 60;

/** A shift's length in minutes. An end at or before the start runs past midnight. */
export function shiftLengthMinutes(startMinute: number, endMinute: number): number {
  return (endMinute <= startMinute ? endMinute + 24 * 60 : endMinute) - startMinute;
}

/** Roster statuses whose shift times are the person's regular duty that day. */
const REGULAR_STATUSES = new Set(["DUTY", "COVERAGE"]);
/**
 * Roster statuses that mean no regular duty that day. EXTRA_DUTY is "working beyond their normal
 * schedule at the manager's request" — the work itself is the overtime, so it carries no regular
 * duty to subtract (its shift window still decides which day after-midnight work belongs to).
 */
const NO_DUTY_STATUSES = new Set(["OFF", "LEAVE", "HOLIDAY", "EXTRA_DUTY"]);

export interface DutyDayEvidence {
  /** The roster row for the day, if any. UNASSIGNED is "nobody decided" and reads as no row. */
  assignment: { status: string; startMinute: number | null; endMinute: number | null } | null;
  /** An organisation holiday on that date (Holiday). */
  isHoliday: boolean;
  /**
   * The member's weekly pattern entry for that weekday, ONLY if it already existed unchanged on that
   * date: a shift, "OFF" (decided: off), or null (no entry, or one changed since).
   */
  pattern: { startMinute: number; endMinute: number } | "OFF" | null;
  /** The member's default shift, only if unchanged since before that date. */
  defaultShift: { startMinute: number; endMinute: number } | null;
  /** The project's default duty length, minutes. */
  fallbackMinutes: number;
}

/**
 * Regular duty for one member on one day, in priority order:
 *   1. the roster for that date — DUTY / COVERAGE with shift times: that shift's length;
 *      OFF / LEAVE / HOLIDAY / EXTRA_DUTY: no regular duty;
 *   2. an organisation holiday on that date: no regular duty;
 *   3. the weekly pattern for that weekday (an entry with no shift = decided off);
 *   4. the member's default shift;
 *   5. the project's default duty length (8 hours unless changed).
 * A shift's length is its configured start-to-end time; this app records no breaks to deduct.
 * Never inferred from a shift's name.
 */
export function resolveRegularDuty(evidence: DutyDayEvidence): ResolvedDuty {
  const shift = (startMinute: number, endMinute: number, source: DutySource): ResolvedDuty => ({
    regularSeconds: shiftLengthMinutes(startMinute, endMinute) * 60,
    startMinute,
    endMinute,
    source,
  });
  // UNASSIGNED is "nobody decided" — the same as no roster row.
  const rostered = evidence.assignment && evidence.assignment.status !== "UNASSIGNED" ? evidence.assignment : null;
  if (rostered) {
    if (NO_DUTY_STATUSES.has(rostered.status)) {
      return { regularSeconds: 0, startMinute: rostered.startMinute, endMinute: rostered.endMinute, source: "NO_DUTY" };
    }
    if (REGULAR_STATUSES.has(rostered.status) && rostered.startMinute !== null && rostered.endMinute !== null) {
      return shift(rostered.startMinute, rostered.endMinute, "ROSTER");
    }
    // Rostered ON DUTY with no shift times: it is a working day, so a holiday or an "off" pattern
    // does not apply; the length comes from the pattern's shift, the default shift or the fallback.
  } else {
    if (evidence.isHoliday) return { regularSeconds: 0, startMinute: null, endMinute: null, source: "NO_DUTY" };
    if (evidence.pattern === "OFF") return { regularSeconds: 0, startMinute: null, endMinute: null, source: "NO_DUTY" };
  }
  if (evidence.pattern && evidence.pattern !== "OFF") return shift(evidence.pattern.startMinute, evidence.pattern.endMinute, "WEEKLY_PATTERN");
  if (evidence.defaultShift) return shift(evidence.defaultShift.startMinute, evidence.defaultShift.endMinute, "DEFAULT_SHIFT");
  const minutes = clampFallbackMinutes(evidence.fallbackMinutes);
  return { regularSeconds: minutes * 60, startMinute: null, endMinute: null, source: "FALLBACK" };
}

/** A usable default duty length: whole minutes between 1 and 16 hours, else 8 hours. */
export function clampFallbackMinutes(minutes: number | null | undefined): number {
  if (typeof minutes !== "number" || !Number.isFinite(minutes)) return DEFAULT_OVERTIME_FALLBACK_DUTY_MINUTES;
  return Math.min(MAX_FALLBACK_DUTY_MINUTES, Math.max(MIN_FALLBACK_DUTY_MINUTES, Math.round(minutes)));
}

export interface OvertimeDay {
  memberId: string;
  /** YYYY-MM-DD, Asia/Dhaka. */
  day: string;
  overtimeSeconds: number;
  source: DutySource;
}

const dayStartMs = (dateKey: string) => {
  const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) - DHAKA_OFFSET_MS;
};
const previousDay = (dateKey: string) => formatDhakaDateKey(new Date(dayStartMs(dateKey) - 12 * 3_600_000));

interface Stretch {
  start: number;
  end: number;
}

/**
 * Daily overtime for each member with any recorded work.
 *
 * @param stretches  each member's support stretches (the Team Report's `splitIntoStretches`), in the
 *                   report's scope and period.
 * @param dutyFor    the member's resolved regular duty for a day (`resolveRegularDuty`).
 */
export function computeOvertimeDays(
  stretches: ReadonlyMap<string, readonly Stretch[]>,
  dutyFor: (memberId: string, day: string) => ResolvedDuty,
): OvertimeDay[] {
  return computeOvertimeWork(stretches, dutyFor).map(({ workedSeconds: _worked, ...day }) => day);
}

/** `computeOvertimeDays` with each day's worked support seconds — what a scoped report shares overtime by. */
export function computeOvertimeWork(
  stretches: ReadonlyMap<string, readonly Stretch[]>,
  dutyFor: (memberId: string, day: string) => ResolvedDuty,
): Array<OvertimeDay & { workedSeconds: number }> {
  const out: Array<OvertimeDay & { workedSeconds: number }> = [];
  for (const [memberId, list] of stretches) {
    if (list.length === 0) continue;
    // Every day a stretch touches, and the day before each (its shift may run past midnight).
    const days = new Set<string>();
    for (const s of list) {
      const day = formatDhakaDateKey(new Date(s.start));
      days.add(day);
      days.add(previousDay(day));
    }
    const duties = new Map([...days].map((day) => [day, dutyFor(memberId, day)]));

    // Shift windows, later ones starting where an earlier one ended so no instant counts twice.
    const windows = [...duties.entries()]
      .filter(([, d]) => d.startMinute !== null && d.endMinute !== null)
      .map(([day, d]) => {
        const base = dayStartMs(day);
        return { day, start: base + d.startMinute! * 60_000, end: base + (d.startMinute! + shiftLengthMinutes(d.startMinute!, d.endMinute!)) * 60_000 };
      })
      .sort((a, b) => a.start - b.start);
    for (let i = 1; i < windows.length; i++) windows[i]!.start = Math.max(windows[i]!.start, windows[i - 1]!.end);

    // Worked seconds per day: inside a window → that window's day; the rest → its calendar day.
    // Rounded exactly as the Team Report rounds a stretch, so the days add up to its support time.
    const worked = new Map<string, number>();
    const add = (day: string, seconds: number) => worked.set(day, (worked.get(day) ?? 0) + seconds);
    for (const s of list) {
      const total = Math.round((s.end - s.start) / 1000);
      let inside = 0;
      for (const w of windows) {
        const overlap = Math.min(s.end, w.end) - Math.max(s.start, w.start);
        if (overlap <= 0) continue;
        const seconds = Math.min(total - inside, Math.round(overlap / 1000));
        if (seconds <= 0) continue;
        add(w.day, seconds);
        inside += seconds;
      }
      if (total - inside > 0) add(formatDhakaDateKey(new Date(s.start)), total - inside);
    }

    for (const [day, seconds] of worked) {
      const duty = duties.get(day) ?? dutyFor(memberId, day);
      out.push({ memberId, day, overtimeSeconds: Math.max(0, seconds - duty.regularSeconds), workedSeconds: seconds, source: duty.source });
    }
  }
  out.sort((a, b) => a.memberId.localeCompare(b.memberId) || a.day.localeCompare(b.day));
  return out;
}

/** Plain-language data-quality reading of a source. Never states a duration. */
export const DUTY_SOURCE_LABELS: Record<DutySource, string> = {
  ROSTER: "Roster",
  WEEKLY_PATTERN: "Weekly pattern",
  DEFAULT_SHIFT: "Default shift",
  NO_DUTY: "Day off / leave / holiday / extra duty",
  FALLBACK: "No schedule — default duty length used",
};
