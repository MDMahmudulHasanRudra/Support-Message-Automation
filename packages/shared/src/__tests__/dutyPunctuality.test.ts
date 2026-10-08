import { describe, expect, it } from "vitest";
import {
  computePunctuality,
  formatMinutesShort,
  formatMinuteOfDay,
  isCrossMidnight,
  minutesFromDutyMidnight,
  normalisedShiftEnd,
} from "../dutyPunctuality.js";

/**
 * The scheduled-against-observed arithmetic behind Duty History.
 *
 * Every case here is one a real roster produces: a late shift that crosses midnight, a message at
 * 02:00 Dhaka belonging to the previous day's shift, a grace period landing exactly on its own
 * boundary, and a day with a single message. `apps/web` has no test runner, which is why this lives
 * in `packages/shared` — the page reads a payroll conversation off these numbers.
 */

/** The Dhaka calendar day as Prisma stores it: midnight UTC of that date. */
const DUTY_DATE = new Date("2026-09-14T00:00:00.000Z");

/** A real instant, given as the wall-clock time somebody in Dhaka would read. Dhaka is UTC+6. */
function dhaka(hour: number, minute = 0, dayOffset = 0): Date {
  return new Date(Date.UTC(2026, 8, 14 + dayOffset, hour - 6, minute));
}

const MORNING = { shiftStartMinute: 10 * 60, shiftEndMinute: 19 * 60 }; // 10:00 – 19:00
const LATE_NIGHT = { shiftStartMinute: 22 * 60, shiftEndMinute: 6 * 60 }; // 22:00 – 06:00

function compute(over: Partial<Parameters<typeof computePunctuality>[0]> = {}) {
  return computePunctuality({
    dutyDate: DUTY_DATE,
    ...MORNING,
    firstActivityAt: dhaka(10),
    lastActivityAt: dhaka(19),
    latenessGraceMinutes: 15,
    earlyDepartureGraceMinutes: 15,
    ...over,
  });
}

describe("minutesFromDutyMidnight", () => {
  it("reads a Dhaka wall-clock time as minutes into its own day", () => {
    expect(minutesFromDutyMidnight(DUTY_DATE, dhaka(0))).toBe(0);
    expect(minutesFromDutyMidnight(DUTY_DATE, dhaka(10, 47))).toBe(10 * 60 + 47);
    expect(minutesFromDutyMidnight(DUTY_DATE, dhaka(23, 59))).toBe(23 * 60 + 59);
  });

  it("carries past 1440 for the small hours of the NEXT day", () => {
    // 02:00 on the 15th is where a 22:00–06:00 shift rostered on the 14th actually ends.
    expect(minutesFromDutyMidnight(DUTY_DATE, dhaka(2, 0, 1))).toBe(26 * 60);
  });
});

describe("cross-midnight shifts", () => {
  it("recognises the endMinute <= startMinute encoding the schema documents", () => {
    expect(isCrossMidnight(22 * 60, 6 * 60)).toBe(true);
    expect(isCrossMidnight(10 * 60, 19 * 60)).toBe(false);
    // A shift that ends exactly when it starts is a full 24 hours, not a zero-length one.
    expect(isCrossMidnight(10 * 60, 10 * 60)).toBe(true);
  });

  it("puts the end on the same timeline as the start so they can be compared", () => {
    expect(normalisedShiftEnd(22 * 60, 6 * 60)).toBe(30 * 60);
    expect(normalisedShiftEnd(10 * 60, 19 * 60)).toBe(19 * 60);
  });

  it("does not call a night-shift worker eight hours early for finishing at 06:00", () => {
    const verdict = compute({
      ...LATE_NIGHT,
      firstActivityAt: dhaka(22),
      lastActivityAt: dhaka(6, 0, 1),
    });
    expect(verdict.isLate).toBe(false);
    expect(verdict.isEarlyFinish).toBe(false);
    expect(verdict.engagedMinutes).toBe(8 * 60);
  });
});

describe("lateness", () => {
  it("reports a small overrun without calling it late", () => {
    // The whole point of a grace period: +8m is visible, and is not a verdict.
    const verdict = compute({ firstActivityAt: dhaka(10, 8) });
    expect(verdict.lateByMinutes).toBe(8);
    expect(verdict.isLate).toBe(false);
  });

  it("flags a real late start", () => {
    const verdict = compute({ firstActivityAt: dhaka(10, 47) });
    expect(verdict.lateByMinutes).toBe(47);
    expect(verdict.isLate).toBe(true);
  });

  it("treats the grace boundary itself as on time", () => {
    // Exactly 15 past with a 15-minute grace is within it. "More than the grace" is the rule.
    expect(compute({ firstActivityAt: dhaka(10, 15) }).isLate).toBe(false);
    expect(compute({ firstActivityAt: dhaka(10, 16) }).isLate).toBe(true);
  });

  it("reports nothing at all for somebody who started early", () => {
    const verdict = compute({ firstActivityAt: dhaka(9, 30) });
    expect(verdict.lateByMinutes).toBeNull();
    expect(verdict.isLate).toBe(false);
  });

  it("honours a grace of zero without treating it as unset", () => {
    expect(compute({ firstActivityAt: dhaka(10, 1), latenessGraceMinutes: 0 }).isLate).toBe(true);
    expect(compute({ firstActivityAt: dhaka(10), latenessGraceMinutes: 0 }).isLate).toBe(false);
  });

  it("refuses to turn a negative grace into a requirement to arrive early", () => {
    expect(compute({ firstActivityAt: dhaka(10), latenessGraceMinutes: -30 }).isLate).toBe(false);
  });
});

describe("early finish", () => {
  it("flags stopping well before the shift ends", () => {
    const verdict = compute({ lastActivityAt: dhaka(16, 30) });
    expect(verdict.leftEarlyByMinutes).toBe(150);
    expect(verdict.isEarlyFinish).toBe(true);
  });

  it("does not flag finishing inside the grace", () => {
    const verdict = compute({ lastActivityAt: dhaka(18, 50) });
    expect(verdict.leftEarlyByMinutes).toBe(10);
    expect(verdict.isEarlyFinish).toBe(false);
  });

  it("says nothing about somebody who worked past the end", () => {
    const verdict = compute({ lastActivityAt: dhaka(20, 15) });
    expect(verdict.leftEarlyByMinutes).toBeNull();
    expect(verdict.isEarlyFinish).toBe(false);
  });
});

describe("what it refuses to conclude", () => {
  it("makes no claim when no message was stored", () => {
    // Silence is not evidence. AttendanceOverride is the only route to a verdict about a person.
    const verdict = compute({ firstActivityAt: null, lastActivityAt: null });
    expect(verdict.reason).toBe("NO_EVIDENCE");
    expect(verdict.isLate).toBe(false);
    expect(verdict.isEarlyFinish).toBe(false);
    expect(verdict.startedMinute).toBeNull();
  });

  it("shows the hours but no verdict when there was no shift to be late for", () => {
    // An off-day with activity is OFF_DAY_DUTY — worth seeing the hours for, never worth a
    // punctuality judgement against a shift that does not exist.
    const verdict = compute({
      shiftStartMinute: null,
      shiftEndMinute: null,
      firstActivityAt: dhaka(11),
      lastActivityAt: dhaka(15),
    });
    expect(verdict.reason).toBe("NO_SHIFT");
    expect(verdict.engagedMinutes).toBe(4 * 60);
    expect(verdict.isLate).toBe(false);
    expect(verdict.lateByMinutes).toBeNull();
  });

  it("reports a single-message day as zero minutes rather than something flattering", () => {
    const at = dhaka(11, 30);
    expect(compute({ firstActivityAt: at, lastActivityAt: at }).engagedMinutes).toBe(0);
  });
});

describe("formatting", () => {
  it("prints a minute-of-day, including one that ran past midnight", () => {
    expect(formatMinuteOfDay(10 * 60 + 47)).toBe("10:47");
    expect(formatMinuteOfDay(0)).toBe("00:00");
    expect(formatMinuteOfDay(26 * 60)).toBe("02:00");
  });

  it("prints a duration in the reports' one format: total hours and minutes", () => {
    expect(formatMinutesShort(47)).toBe("0h 47m");
    expect(formatMinutesShort(60)).toBe("1h 0m");
    expect(formatMinutesShort(192)).toBe("3h 12m");
    expect(formatMinutesShort(1500)).toBe("25h 0m");
    expect(formatMinutesShort(0)).toBe("0h 0m");
    expect(formatMinutesShort(null)).toBe("—");
  });
});
