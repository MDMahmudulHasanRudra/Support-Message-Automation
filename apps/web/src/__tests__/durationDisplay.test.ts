import { describe, expect, it } from "vitest";
import { formatHoursMinutes } from "@support-automation/shared";
import { formatDurationShort } from "@/lib/duration";
import { duration } from "@/server/reports/format";
import { formatDuration } from "@/server/teamReportTables";

/**
 * Every report shows a duration ONE way — total hours and minutes, never days, never seconds — and
 * every report formatter is that one function, so a Team Report cell, a /reports/<id> cell and the
 * Excel/CSV text built from them cannot disagree. The Team Report's own examples: Bipul's 1d 11h is
 * 35h 0m, Rakib's 1d 3h is 27h 0m, Mahfuz's 1d 0h is 24h 0m, Khairul's 23h 29m is unchanged.
 */
const CASES: Array<[number, string]> = [
  [0, "0h 0m"],
  [59, "0h 0m"],
  [60, "0h 1m"],
  [3599, "0h 59m"],
  [3600, "1h 0m"],
  [3660, "1h 1m"],
  [86_399, "23h 59m"],
  [86_400, "24h 0m"],
  [90_000, "25h 0m"],
  [97_200, "27h 0m"],
  [126_000, "35h 0m"],
  [23 * 3600 + 29 * 60, "23h 29m"],
  [35 * 3600 + 42 * 60 + 39, "35h 42m"],
];

describe("report duration display", () => {
  it.each(CASES)("%i s → %s in every report formatter", (seconds, expected) => {
    expect(formatHoursMinutes(seconds)).toBe(expected);
    expect(formatDurationShort(seconds)).toBe(expected);
    expect(duration(seconds)).toBe(expected);
    expect(formatDuration(seconds)).toBe(expected);
  });

  it("no value is still a dash, not a zero", () => {
    expect(duration(null)).toBe("—");
  });

  it("never prints days or seconds", () => {
    for (const s of [45, 86_400 * 3 + 7, 400_000]) {
      expect(formatDurationShort(s)).not.toMatch(/\dd\b|\ds\b/);
    }
  });
});
