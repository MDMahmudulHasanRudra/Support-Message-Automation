import type { SupportActivityCountingPeriod } from "@prisma/client";

// Asia/Dhaka is a fixed UTC+6 offset with no DST — safe to hardcode a constant offset for day-
// boundary math, unlike display formatting (see lib/date.ts's own comment on why display
// formatting must go through Intl.DateTimeFormat instead: the server process's own timezone can't
// be trusted). Kept as its own file rather than added to date.ts since date.ts is display-only.
const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** [start, end) UTC instants bounding the Dhaka calendar day that contains `when`. */
export function getDhakaDayRange(when: Date): { start: Date; end: Date } {
  const dhakaMidnightMs = Math.floor((when.getTime() + DHAKA_OFFSET_MS) / DAY_MS) * DAY_MS;
  const start = new Date(dhakaMidnightMs - DHAKA_OFFSET_MS);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

/** [start, end) UTC instants bounding the Dhaka calendar week (Sunday-start) containing `when`. */
export function getDhakaWeekRange(when: Date): { start: Date; end: Date } {
  const dhakaMidnightMs = Math.floor((when.getTime() + DHAKA_OFFSET_MS) / DAY_MS) * DAY_MS;
  const dayOfWeek = new Date(dhakaMidnightMs).getUTCDay(); // 0 = Sunday, treating the shifted instant as UTC
  const weekStartShiftedMs = dhakaMidnightMs - dayOfWeek * DAY_MS;
  const start = new Date(weekStartShiftedMs - DHAKA_OFFSET_MS);
  return { start, end: new Date(start.getTime() + 7 * DAY_MS) };
}

/** [start, end) UTC instants bounding the Dhaka calendar month containing `when`. */
export function getDhakaMonthRange(when: Date): { start: Date; end: Date } {
  const shifted = new Date(when.getTime() + DHAKA_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth();
  const start = new Date(Date.UTC(year, month, 1) - DHAKA_OFFSET_MS);
  const end = new Date(Date.UTC(year, month + 1, 1) - DHAKA_OFFSET_MS);
  return { start, end };
}

/** Dispatches on SupportActivitySettings.countingPeriod for the report pages/detector to share. */
export function getSupportActivityPeriodRange(
  period: SupportActivityCountingPeriod,
  when: Date,
): { start: Date; end: Date } {
  switch (period) {
    case "WEEKLY":
      return getDhakaWeekRange(when);
    case "MONTHLY":
      return getDhakaMonthRange(when);
    case "DAILY":
      return getDhakaDayRange(when);
  }
}

/**
 * A `YYYY-MM-DD` value from an `<input type="date">` (or a URL query param) resolved to the Dhaka
 * calendar day it names — `null` when it is absent or is not a real date, so a caller can ignore a
 * malformed filter instead of handing Prisma an Invalid Date and getting a validation crash.
 *
 * The browser's date input always submits UTC-shaped `YYYY-MM-DD`, but the day it names is the
 * user's day, which here is Dhaka's — parsing it as a UTC instant shifts the window six hours.
 */
export function parseDhakaDayFromInput(value: string | null | undefined): { start: Date; end: Date } | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const utcMidnightMs = Date.UTC(year, month, day);
  if (Number.isNaN(utcMidnightMs)) return null;

  // Date.UTC rolls an impossible component over rather than rejecting it (2026-02-31 becomes
  // March 3), so round-trip and refuse anything that did not come back as it was typed.
  const roundTrip = new Date(utcMidnightMs);
  if (roundTrip.getUTCFullYear() !== year || roundTrip.getUTCMonth() !== month || roundTrip.getUTCDate() !== day) {
    return null;
  }

  const start = new Date(utcMidnightMs - DHAKA_OFFSET_MS);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

/**
 * [start, end) spanning the Dhaka days named by two date-input values, inclusive of both — the
 * shape a "from / to" filter pair means. Null unless both parse, so a half-filled or malformed
 * pair falls back to the caller's default window rather than silently filtering on garbage.
 */
export function parseDhakaDayRangeFromInput(
  from: string | null | undefined,
  to: string | null | undefined,
): { start: Date; end: Date } | null {
  const fromDay = parseDhakaDayFromInput(from);
  const toDay = parseDhakaDayFromInput(to);
  if (!fromDay || !toDay) return null;
  if (toDay.end <= fromDay.start) return null;
  return { start: fromDay.start, end: toDay.end };
}
