import type { SupportActivityCountingPeriod } from "@prisma/client";
import { getDhakaDayRange, getDhakaMonthRange, getDhakaWeekRange } from "@support-automation/shared";

/**
 * Dhaka calendar-period helpers for the dashboard.
 *
 * The day/week/month arithmetic itself moved to `packages/shared/src/dhakaDay.ts` once Team
 * Management's worker-side attendance hook needed the same maths: the worker decides which
 * calendar day a message belongs to and this app decides which day it is displaying, and two
 * implementations of "what day is it in Dhaka" would disagree for six hours out of every
 * twenty-four. They are re-exported here so every existing caller keeps importing from the same
 * place — this was a move, not a rewrite.
 *
 * `getSupportActivityPeriodRange` stays here rather than moving with them because it takes a Prisma
 * enum, and `packages/shared` deliberately cannot depend on `@prisma/client` (the engine could not
 * import it, which is why the shared package exists at all).
 */

export {
  DHAKA_OFFSET_MS,
  formatDhakaDateKey,
  getDhakaDayRange,
  getDhakaMonthRange,
  getDhakaWeekday,
  getDhakaWeekRange,
  parseDhakaDayFromInput,
  parseDhakaDayRangeFromInput,
  toDhakaDateOnly,
} from "@support-automation/shared";

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
