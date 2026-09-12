/**
 * Dhaka calendar-day arithmetic, shared by the web app and the worker.
 *
 * Asia/Dhaka is a fixed UTC+6 offset with no DST, so a constant offset is safe for day-boundary
 * maths — unlike display formatting, which must go through `Intl.DateTimeFormat` because the
 * server process's own timezone cannot be trusted.
 *
 * This lives in `packages/shared` rather than `apps/web/src/lib` because BOTH sides now need it and
 * they must agree exactly. The worker decides which calendar day a message belongs to; the
 * dashboard decides which calendar day it is showing. Two implementations of "what day is it in
 * Dhaka" would disagree for six hours out of every twenty-four, and the symptom would be
 * attendance quietly landing on the wrong day for anything sent between midnight and 06:00 UTC.
 *
 * `apps/web/src/lib/supportActivityPeriod.ts` re-exports these so every existing caller keeps
 * working untouched; the period dispatcher stays there because it takes a Prisma enum and
 * `packages/shared` deliberately cannot depend on `@prisma/client`.
 */

export const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;
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

/**
 * The Dhaka calendar day containing `when`, as the midnight-UTC `Date` a Postgres `DATE` column
 * expects.
 *
 * Prisma writes a `@db.Date` field from a JS `Date` by taking its UTC date part, so a message sent
 * at 02:00 Dhaka on the 13th — which is 20:00 UTC on the 12th — must be handed back as the 13th,
 * not the 12th. Passing the raw instant is the bug this function exists to prevent, and it is
 * invisible until somebody works a late shift.
 */
export function toDhakaDateOnly(when: Date): Date {
  const shifted = new Date(when.getTime() + DHAKA_OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
}

/** 0 = Sunday .. 6 = Saturday, in Dhaka. Matches `getDhakaWeekRange`'s Sunday start. */
export function getDhakaWeekday(when: Date): number {
  return new Date(when.getTime() + DHAKA_OFFSET_MS).getUTCDay();
}

/** `YYYY-MM-DD` for a Dhaka calendar day — the form `<input type="date">` and URLs both use. */
export function formatDhakaDateKey(when: Date): string {
  return toDhakaDateOnly(when).toISOString().slice(0, 10);
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
  const month = Number(match[2]);
  const day = Number(match[3]);

  // Round-tripping through Date.UTC is what rejects 2026-02-31: the constructor rolls it forward to
  // March 3rd, and comparing the parts back out catches that a real date was never named.
  const asUtc = new Date(Date.UTC(year, month - 1, day));
  if (
    asUtc.getUTCFullYear() !== year ||
    asUtc.getUTCMonth() !== month - 1 ||
    asUtc.getUTCDate() !== day
  ) {
    return null;
  }

  const start = new Date(asUtc.getTime() - DHAKA_OFFSET_MS);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

/**
 * [start, end) spanning the Dhaka days named by two date-input values, inclusive of both — the
 * shape a "from / to" filter pair means. Null unless both parse, so a half-filled or malformed
 * pair falls back to the caller's default window rather than silently filtering on garbage, and
 * null for a reversed pair, which would otherwise produce an empty window that reads as "no
 * results" rather than "you typed the dates the wrong way round".
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
