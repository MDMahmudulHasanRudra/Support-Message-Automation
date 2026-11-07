import { beforeEach, describe, expect, it } from "vitest";
import { MAX_WAIT_MS, QUIET_AFTER_MS, messageWorkInProgress, noteOutboundSend, resetMessagesFirst, slowJobMayRun, trackMessageWork } from "../messagesFirst.js";

describe("customer messages go before slow jobs", () => {
  beforeEach(() => resetMessagesFirst());

  it("lets a slow job run when nothing is happening", () => {
    expect(slowJobMayRun("admin", 1_000_000)).toBe(true);
  });

  it("holds a slow job while a message is being handled, and releases it afterwards", async () => {
    let finish = () => {};
    const handling = trackMessageWork(() => new Promise<void>((resolve) => (finish = resolve)));
    expect(messageWorkInProgress()).toBe(true);
    expect(slowJobMayRun("admin")).toBe(false);
    finish();
    await handling;
    expect(messageWorkInProgress()).toBe(false);
    expect(slowJobMayRun("admin")).toBe(true);
  });

  it("still counts a message that failed as finished", async () => {
    await trackMessageWork(() => Promise.reject(new Error("no"))).catch(() => undefined);
    expect(messageWorkInProgress()).toBe(false);
  });

  it("holds a slow job just after a send, then lets it go", () => {
    const now = 5_000_000;
    noteOutboundSend(now);
    expect(slowJobMayRun("add", now + 100)).toBe(false);
    expect(slowJobMayRun("add", now + QUIET_AFTER_MS)).toBe(true);
  });

  it("never starves a slow job on a number that never goes quiet", () => {
    const start = 9_000_000;
    let ran = 0;
    for (let t = 0; t <= MAX_WAIT_MS * 3; t += 2_000) {
      noteOutboundSend(start + t);
      if (slowJobMayRun("admin", start + t)) ran += 1;
    }
    expect(ran).toBeGreaterThanOrEqual(2);
    expect(ran).toBeLessThanOrEqual(3);
  });
});
