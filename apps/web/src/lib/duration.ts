import { formatHoursMinutes } from "@support-automation/shared";

/**
 * Formats a duration given in seconds the reports' one way: total hours and minutes ("35h 0m",
 * "2h 15m", "0h 45m") — never days, never seconds (`formatHoursMinutes`, packages/shared). It used
 * to switch to "1d 11h" past a day and "38s" under a minute. Kept separate from overview/page.tsx's
 * own formatAgeShort(), which is an age since a timestamp, not a duration.
 */
export function formatDurationShort(totalSeconds: number): string {
  return formatHoursMinutes(totalSeconds);
}

/** Elapsed time between two instants, formatted the same way — used for an in-progress OPEN
 *  session's "so far" duration, always computed at render time, never persisted. */
export function formatElapsedShort(since: Date, now: Date = new Date()): string {
  return formatDurationShort((now.getTime() - since.getTime()) / 1000);
}
