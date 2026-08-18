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
