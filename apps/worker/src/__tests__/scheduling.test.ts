import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { scheduleStartupCatchUp } from "../scheduling.js";

/**
 * Pure unit test — no database, no network. Fake timers, because the whole point of the helper is
 * what it decides after a delay, and a real one-minute wait is not a test.
 */

const HOUR = 60 * 60_000;

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * HOUR);
}

describe("scheduleStartupCatchUp", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function fire(lastRunAt: Date | null, intervalMs: number) {
    const run = vi.fn().mockResolvedValue(undefined);
    scheduleStartupCatchUp({
      name: "test job",
      intervalMs,
      delayMs: 1_000,
      lastRunAt: async () => lastRunAt,
      run,
    });
    await vi.advanceTimersByTimeAsync(1_100);
    return run;
  }

  it("runs a job whose last completion is older than its interval", async () => {
    // The real case: a six-hour loop that last finished twenty-seven hours ago because every
    // deploy reset its interval before it could tick.
    const run = await fire(hoursAgo(27), 6 * HOUR);
    expect(run).toHaveBeenCalledOnce();
  });

  it("leaves a job alone when it ran within its interval", async () => {
    const run = await fire(hoursAgo(1), 6 * HOUR);
    expect(run).not.toHaveBeenCalled();
  });

  it("treats never-completed as overdue", async () => {
    // A job with no recorded run has either never been due or never got to run; either way the
    // jobs themselves no-op when their feature is off, so running costs nothing and starting a
    // fresh install without waiting six hours is the better default.
    const run = await fire(null, 6 * HOUR);
    expect(run).toHaveBeenCalledOnce();
  });

  it("does not run before its delay has elapsed", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    scheduleStartupCatchUp({
      name: "test job",
      intervalMs: 6 * HOUR,
      delayMs: 60_000,
      lastRunAt: async () => hoursAgo(27),
      run,
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(run).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(31_000);
    expect(run).toHaveBeenCalledOnce();
  });

  it("survives a lastRunAt that throws, without running the job", async () => {
    // Boot must not fail because a timestamp could not be read; the ordinary interval is still
    // running and will cover it.
    const run = vi.fn().mockResolvedValue(undefined);
    scheduleStartupCatchUp({
      name: "test job",
      intervalMs: 6 * HOUR,
      delayMs: 1_000,
      lastRunAt: async () => {
        throw new Error("database unreachable");
      },
      run,
    });

    await expect(vi.advanceTimersByTimeAsync(1_100)).resolves.not.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it("swallows a failure from the job itself", async () => {
    const run = vi.fn().mockRejectedValue(new Error("sync exploded"));
    scheduleStartupCatchUp({
      name: "test job",
      intervalMs: 6 * HOUR,
      delayMs: 1_000,
      lastRunAt: async () => hoursAgo(27),
      run,
    });

    await expect(vi.advanceTimersByTimeAsync(1_100)).resolves.not.toThrow();
    expect(run).toHaveBeenCalledOnce();
  });
});
