import { describe, expect, it } from "vitest";
import { resolveSweepWindow, shouldAutomateRecoveredMessage } from "../pipeline/catchUpMissedMessages.js";

/**
 * Pure unit tests — no database, no browser. These two functions decide how much history a restart
 * drags back in and, more importantly, whether a real customer receives an automated reply to a
 * question they asked while nobody was listening. Both are the kind of thing a later change can
 * shift by a factor of ten without anything visibly breaking, which is exactly what a test is for.
 *
 * The sweep itself is exercised against a real database by the integration suite.
 */

const NOW = new Date("2026-09-11T12:00:00.000Z").getTime();
const minutesAgo = (n: number) => new Date(NOW - n * 60_000);
const hoursAgo = (n: number) => new Date(NOW - n * 60 * 60_000);

describe("resolveSweepWindow", () => {
  it("has nothing to sweep before the account has ever processed a message", () => {
    // A brand-new number's backlog is conversation from before it was part of this system.
    expect(resolveSweepWindow(null, NOW)).toBeNull();
  });

  it("ignores a gap too short to have lost anything worth hunting for", () => {
    expect(resolveSweepWindow(new Date(NOW - 12_000), NOW)).toBeNull();
  });

  it("sweeps from the last processed message when the gap is real", () => {
    const window = resolveSweepWindow(minutesAgo(20), NOW);
    expect(window?.since).toEqual(minutesAgo(20));
    expect(window?.gapMs).toBe(20 * 60_000);
  });

  it("floors a long outage rather than replaying everything since it began", () => {
    // The worker was off for three days. Reading three days of conversation back in would be an
    // enormous amount of work to produce records for conversations that ended long ago.
    const window = resolveSweepWindow(hoursAgo(72), NOW);
    expect(window?.since).toEqual(hoursAgo(12));
  });
});

describe("shouldAutomateRecoveredMessage", () => {
  it("still answers a question missed during a restart", () => {
    // Four minutes is a worker restart. Nothing about that is the customer's problem.
    expect(shouldAutomateRecoveredMessage(minutesAgo(4), NOW)).toBe(true);
  });

  it("does not answer this morning's question at lunchtime", () => {
    // By now a colleague has very likely replied in the group, and an automated answer arriving
    // hours late reads as broken. The message is still stored — it simply is not replied to.
    expect(shouldAutomateRecoveredMessage(hoursAgo(5), NOW)).toBe(false);
    expect(shouldAutomateRecoveredMessage(minutesAgo(45), NOW)).toBe(false);
  });

  it("treats a message exactly on the boundary as answerable", () => {
    expect(shouldAutomateRecoveredMessage(minutesAgo(15), NOW)).toBe(true);
    expect(shouldAutomateRecoveredMessage(minutesAgo(16), NOW)).toBe(false);
  });
});
