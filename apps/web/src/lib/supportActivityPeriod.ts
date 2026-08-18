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
