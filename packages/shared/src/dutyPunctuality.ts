import { DHAKA_OFFSET_MS } from "./dhakaDay.js";

/**
 * Comparing the shift somebody was rostered onto against the hours their messages actually show.
 *
 * Duty History has always promised "scheduled against observed" and only ever delivered half of it:
 * the scheduled shift was printed in full ("Morning 10:00 – 19:00") beside a message count, while
 * `TeamAttendanceDay.firstActivityAt` / `lastActivityAt` — written on every single message since
 * the attendance hook shipped — were never read on that page. The two numbers a manager opens a
 * timesheet to find, when somebody started and when they stopped, were in the database the whole
 * time and on screen nowhere.
 *
 * PURE, and in `packages/shared` rather than beside the page, for the reason `dhakaDay.ts` is here:
 * `apps/web` has no test runner, and this is arithmetic with real edge cases — a cross-midnight
 * shift, a grace period landing exactly on the boundary, a day with one message. Arithmetic nobody
 * can test is arithmetic nobody should trust on a page that feeds payroll conversations.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It never concludes that somebody did not work. Absence of
 * evidence is not evidence of absence here any more than it is in `deriveDutyState` — a colleague
 * on the phone, at a customer site, or working in a group this account cannot see produces exactly
 * the same silence as one who stayed home. `NO_EVIDENCE` says only that no message was stored, and
 * `AttendanceOverride` remains the one and only route to a verdict about a person.
 */

/** Minutes from local midnight, the unit `ShiftTemplate` and `DutyAssignment` already store. */
export const MINUTES_PER_DAY = 24 * 60;

export interface PunctualityInput {
  /** The Dhaka calendar day this duty belongs to, as stored (`@db.Date`, midnight UTC). */
  dutyDate: Date;
  /** Snapshotted on the assignment, so editing a template never rewrites history. Null = no shift. */
  shiftStartMinute: number | null;
  shiftEndMinute: number | null;
  firstActivityAt: Date | null;
  lastActivityAt: Date | null;
  /** From `TeamManagementSettings`. Never hardcoded — this module forbids a business rule in code. */
  latenessGraceMinutes: number;
  earlyDepartureGraceMinutes: number;
}

export interface Punctuality {
  /** Minutes from Dhaka midnight of the duty date; may exceed 1440 for a cross-midnight shift. */
  startedMinute: number | null;
  endedMinute: number | null;
  /** Last activity minus first. Zero for a day with a single message, which is honest, not flattering. */
  engagedMinutes: number | null;
  /** How far past the shift start the first message was. Null when not late, or not comparable. */
  lateByMinutes: number | null;
  /** How far before the shift end the last message was. Null when not early, or not comparable. */
  leftEarlyByMinutes: number | null;
  /** True only once the relevant grace period is exceeded. */
  isLate: boolean;
  isEarlyFinish: boolean;
  /** Why no comparison was made, when none was. */
  reason: "OK" | "NO_EVIDENCE" | "NO_SHIFT";
}

/** Minutes from the Dhaka midnight that begins `dutyDate`. Negative if the message precedes it. */
export function minutesFromDutyMidnight(dutyDate: Date, when: Date): number {
  // `dutyDate` is a `@db.Date`, which `toDhakaDateOnly` built as midnight UTC of the Dhaka calendar
  // day — a label for the day, not the instant the day began. The instant Dhaka midnight actually
  // occurred is six hours earlier in real time (00:00 Dhaka = 18:00 UTC the day before), and that
  // is what a message timestamp has to be measured from.
  const dhakaMidnightUtcMs = dutyDate.getTime() - DHAKA_OFFSET_MS;
  return Math.round((when.getTime() - dhakaMidnightUtcMs) / 60_000);
}

/**
 * Whether a shift runs past midnight. `endMinute <= startMinute` is the encoding the schema already
 * documents, so a Late shift of 22:00–06:00 is stored as 1320 → 360 rather than 1320 → 1800.
 */
export function isCrossMidnight(startMinute: number, endMinute: number): boolean {
  return endMinute <= startMinute;
}

/** The shift end expressed on the same timeline as the start, so a comparison is possible at all. */
export function normalisedShiftEnd(startMinute: number, endMinute: number): number {
  return isCrossMidnight(startMinute, endMinute) ? endMinute + MINUTES_PER_DAY : endMinute;
}

export function computePunctuality(input: PunctualityInput): Punctuality {
  const empty: Punctuality = {
    startedMinute: null,
    endedMinute: null,
    engagedMinutes: null,
    lateByMinutes: null,
    leftEarlyByMinutes: null,
    isLate: false,
    isEarlyFinish: false,
    reason: "OK",
  };

  if (!input.firstActivityAt || !input.lastActivityAt) {
    return { ...empty, reason: "NO_EVIDENCE" };
  }

  const startedMinute = minutesFromDutyMidnight(input.dutyDate, input.firstActivityAt);
  const endedMinute = minutesFromDutyMidnight(input.dutyDate, input.lastActivityAt);
  // Never negative: a single message is a zero-length span, not a backwards one.
  const engagedMinutes = Math.max(0, endedMinute - startedMinute);

  const observed = { ...empty, startedMinute, endedMinute, engagedMinutes };

  // No shift on the row means nothing to be late FOR. An off-day or unassigned day still shows the
  // hours worked — that is exactly the OFF_DAY_DUTY case somebody wants to see — but a punctuality
  // verdict against a shift that does not exist would be invented.
  if (input.shiftStartMinute === null || input.shiftEndMinute === null) {
    return { ...observed, reason: "NO_SHIFT" };
  }

  const shiftEnd = normalisedShiftEnd(input.shiftStartMinute, input.shiftEndMinute);
  // Clamped at zero on both sides: grace is a tolerance, and a negative one would silently turn
  // into a requirement to arrive early.
  const lateGrace = Math.max(0, input.latenessGraceMinutes);
  const earlyGrace = Math.max(0, input.earlyDepartureGraceMinutes);

  const lateBy = startedMinute - input.shiftStartMinute;
  const leftEarlyBy = shiftEnd - endedMinute;

  return {
    ...observed,
    // Reported whenever it is positive, flagged only past the grace — so a page can show "+8m"
    // without calling somebody late for it, which is the distinction a grace period exists to make.
    lateByMinutes: lateBy > 0 ? lateBy : null,
    leftEarlyByMinutes: leftEarlyBy > 0 ? leftEarlyBy : null,
    isLate: lateBy > lateGrace,
    isEarlyFinish: leftEarlyBy > earlyGrace,
    reason: "OK",
  };
}

/** "10:47", from minutes that may have run past midnight. */
export function formatMinuteOfDay(minute: number): string {
  const wrapped = ((minute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hours = Math.floor(wrapped / 60);
  const minutes = wrapped % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** "3h 12m", "47m", "—". Durations here are spans of a working day, never more than a day or two. */
export function formatMinutesShort(minutes: number | null): string {
  if (minutes === null) return "—";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}
