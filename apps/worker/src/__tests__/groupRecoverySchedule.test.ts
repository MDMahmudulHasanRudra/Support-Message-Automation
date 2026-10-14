import { describe, expect, it } from "vitest";
import { backoffAfter, GROUP_RECOVERY_SETTINGS, isOverloaded } from "../commands/groupRecovery.js";

const MIN = 60_000;

describe("the schedule and the load check (pure)", () => {
  it("waits 2, 5, 10, 30 minutes, then 6 hours, and stays at 6 hours", () => {
    expect([0, 1, 2, 3, 4, 5, 50].map((step) => backoffAfter(step) / MIN)).toEqual([2, 5, 10, 30, 360, 360, 360]);
  });

  it("is busy on either signal, and calm otherwise", () => {
    expect(isOverloaded({ loadPerCpu: 0.4, eventLoopDelayMs: 10 })).toBe(false);
    expect(isOverloaded({ loadPerCpu: GROUP_RECOVERY_SETTINGS.maxLoadPerCpu + 0.1, eventLoopDelayMs: 0 })).toBe(true);
    expect(isOverloaded({ loadPerCpu: 0, eventLoopDelayMs: GROUP_RECOVERY_SETTINGS.maxEventLoopDelayMs + 1 })).toBe(true);
  });
});
