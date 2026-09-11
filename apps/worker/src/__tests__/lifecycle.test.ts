import { describe, expect, it } from "vitest";
import { awaitQuiescence, beginShutdown, isShuttingDown, trackTick } from "../lifecycle.js";

/**
 * Pure unit tests — no database, no browser.
 *
 * These assert the two properties that stop a shutdown sending a customer the same reply twice:
 * a tick already running is waited for, and a tick that fires after its interval was cleared does
 * not start new work. Both are easy to break later by moving one line, and neither shows up in
 * anything else.
 *
 * The module holds process-wide state and `beginShutdown` is one-way, so ordering inside this file
 * matters: everything about the running state is asserted before the shutdown block, which is the
 * last thing here.
 */

describe("trackTick while running normally", () => {
  it("runs the tick and returns its value", async () => {
    expect(isShuttingDown()).toBe(false);
    await expect(trackTick(async () => "sent")).resolves.toBe("sent");
  });

  it("lets a failure reach the caller rather than swallowing it", async () => {
    // Each loop attaches its own .catch to log; trackTick must not quietly absorb the error first.
    await expect(trackTick(async () => Promise.reject(new Error("provider refused")))).rejects.toThrow(
      "provider refused",
    );
  });

  it("stops counting a tick that threw, so a failure cannot block shutdown forever", async () => {
    await trackTick(async () => Promise.reject(new Error("boom"))).catch(() => undefined);
    await expect(awaitQuiescence(500)).resolves.toBe(true);
  });

  it("waits for work that is still in flight", async () => {
    let finished = false;
    const slow = trackTick(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      finished = true;
    });

    // The whole point: quiescence is not reached while that tick is running.
    await expect(awaitQuiescence(1_000)).resolves.toBe(true);
    expect(finished).toBe(true);
    await slow;
  });

  it("gives up on work that will not finish, rather than waiting forever", async () => {
    // A tick blocked on a hung provider call must not hold the container open until SIGKILL.
    const hung = trackTick(() => new Promise<void>((resolve) => setTimeout(resolve, 600)));
    await expect(awaitQuiescence(200)).resolves.toBe(false);
    await hung;
  });
});

describe("once shutdown has begun", () => {
  it("refuses to start new work", async () => {
    beginShutdown();
    expect(isShuttingDown()).toBe(true);

    // A tick scheduled before its interval was cleared still fires. It must become a no-op, or a
    // send claimed here is one nobody will be around to finish.
    let ran = false;
    const result = await trackTick(async () => {
      ran = true;
      return "sent";
    });

    expect(ran).toBe(false);
    expect(result).toBeUndefined();
  });

  it("is already quiescent when nothing was running", async () => {
    await expect(awaitQuiescence(200)).resolves.toBe(true);
  });
});
