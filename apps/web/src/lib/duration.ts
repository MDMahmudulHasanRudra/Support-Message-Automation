/**
 * Formats a duration given in whole seconds as a short human string ("2h 15m", "45m", "38s").
 * Kept separate from overview/page.tsx's own formatAgeShort() (a different helper, on a different
 * page, operating on milliseconds-since-a-timestamp rather than a persisted seconds duration) —
 * not merged, per the "don't refactor unrelated code while implementing a feature" convention.
 */
export function formatDurationShort(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.round(totalSeconds));
  const totalMinutes = Math.floor(safeSeconds / 60);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${safeSeconds}s`;
}

/** Elapsed time between two instants, formatted the same way — used for an in-progress OPEN
 *  session's "so far" duration, always computed at render time, never persisted. */
export function formatElapsedShort(since: Date, now: Date = new Date()): string {
  return formatDurationShort((now.getTime() - since.getTime()) / 1000);
}
