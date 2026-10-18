import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const countDropped = vi.fn();
const logEvent = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("../pipeline/dropCounter.js", () => ({ countDroppedMessage: (...a: unknown[]) => countDropped(...a) }));
vi.mock("../logging/logSystemEvent.js", () => ({ logSystemEvent: (...a: unknown[]) => logEvent(...a) }));
vi.mock("../pipeline/processIncomingMessage.js", () => ({ processIncomingMessage: vi.fn(), storeMissedMessage: vi.fn() }));

import { MAX_PENDING_RETRIES, pendingRetryCount, processWithRetry } from "../pipeline/retryFailedMessage.js";
import { selectUnstored } from "../pipeline/reconcileRecentMessages.js";
import type { RawIncomingMessage } from "../pipeline/types.js";

const raw = (id: string, body = "hello"): RawIncomingMessage =>
  ({ accountId: "acc", whatsappMessageId: id, chatId: "1@g.us", whatsappGroupId: "1@g.us", body, direction: "INCOMING", timestampWa: new Date() }) as unknown as RawIncomingMessage;

describe("processWithRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    countDropped.mockClear();
    logEvent.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("does not retry or count anything when the first attempt succeeds", async () => {
    const process = vi.fn().mockResolvedValue(undefined);
    await processWithRetry(raw("a"), process, [10, 10]);
    await vi.advanceTimersByTimeAsync(100);
    expect(process).toHaveBeenCalledTimes(1);
    expect(countDropped).not.toHaveBeenCalled();
  });

  it("processes a message on a later attempt after a transient failure, and counts no drop", async () => {
    const process = vi.fn().mockRejectedValueOnce(new Error("pool timeout")).mockResolvedValue(undefined);
    await processWithRetry(raw("b"), process, [10, 10]);
    expect(process).toHaveBeenCalledTimes(1);
    expect(pendingRetryCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(11);
    expect(process).toHaveBeenCalledTimes(2);
    expect(countDropped).not.toHaveBeenCalled();
    expect(pendingRetryCount()).toBe(0);
  });

  it("counts a drop and logs it only after every chance is used", async () => {
    const process = vi.fn().mockRejectedValue(new Error("db down"));
    await processWithRetry(raw("c"), process, [10, 10]);
    await vi.advanceTimersByTimeAsync(100);
    expect(process).toHaveBeenCalledTimes(3); // first attempt + two retries
    expect(countDropped).toHaveBeenCalledTimes(1);
    // The chat id travels with it, so the drop is counted as a group or a personal one (collectionByKind).
    expect(countDropped).toHaveBeenCalledWith("acc", "PIPELINE_ERROR", "1@g.us");
    expect(logEvent).toHaveBeenCalledWith("ERROR", "pipeline", "Error processing incoming message", expect.objectContaining({ attempts: 3 }));
  });

  it("stops queueing retries at the cap instead of piling up timers", async () => {
    const process = vi.fn().mockRejectedValue(new Error("db down"));
    for (let i = 0; i < MAX_PENDING_RETRIES + 5; i++) await processWithRetry(raw(`m${i}`), process, [1_000_000]);
    expect(pendingRetryCount()).toBe(MAX_PENDING_RETRIES);
    expect(countDropped).toHaveBeenCalledTimes(5); // the overflow is written off immediately
    await vi.advanceTimersByTimeAsync(2_000_000);
  });
});

describe("selectUnstored", () => {
  it("keeps only non-empty messages that are not stored yet", () => {
    const offered = [raw("stored"), raw("missing"), raw("empty", "   "), raw("also-missing")];
    expect(selectUnstored(offered, new Set(["stored"])).map((m) => m.whatsappMessageId)).toEqual(["missing", "also-missing"]);
  });

  it("returns nothing when everything offered is already stored", () => {
    expect(selectUnstored([raw("x"), raw("y")], new Set(["x", "y"]))).toEqual([]);
  });
});
