import { describe, expect, it } from "vitest";
import { formatHoursMinutes } from "../duration.js";

describe("formatHoursMinutes — total hours and minutes, never days, never seconds", () => {
  it.each([
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
    [35 * 3600 + 42 * 60 + 39, "35h 42m"],
    [10 * 86_400 + 5 * 60, "240h 5m"],
  ])("%i s → %s", (seconds, expected) => {
    expect(formatHoursMinutes(seconds)).toBe(expected);
  });

  it("truncates, never rounds up a minute", () => {
    expect(formatHoursMinutes(119.9)).toBe("0h 1m");
  });

  it("reads nonsense as zero", () => {
    expect(formatHoursMinutes(-5)).toBe("0h 0m");
    expect(formatHoursMinutes(Number.NaN)).toBe("0h 0m");
  });
});
