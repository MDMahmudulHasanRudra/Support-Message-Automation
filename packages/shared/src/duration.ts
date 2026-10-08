/**
 * The one way a duration is SHOWN in reports: total hours and minutes — "35h 0m", never "1d 11h",
 * never seconds. Display only: the value passed in is the accurate source (seconds), and nothing
 * here feeds back into a calculation.
 *
 * Minutes are truncated, not rounded: 35h 42m 39s reads "35h 42m", so a displayed figure never
 * claims a minute that was not worked. Zero is "0h 0m"; a negative or non-finite input reads as zero.
 */
export function formatHoursMinutes(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const totalMinutes = Math.floor(safe / 60);
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}
