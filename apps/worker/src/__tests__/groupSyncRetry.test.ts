import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A group sync against a session that cannot be read fails ONCE, with the reason.
 *
 * Observed 24 Sep 2026: after a number was logged out, every "sync groups" press ran three attempts
 * ten and thirty seconds apart, each failing identically inside WhatsApp Web's page. Retrying is
 * for failures that can change on their own — a slow roster, a page still settling — and a
 * logged-out session is not one of them.
 *
 * `getGroups()` is the first thing a sync does, so a provider that throws there never reaches the
 * database; the log writer is stubbed. No database, no browser.
 */

const logged: Array<{ level: string; message: string; metadata?: Record<string, unknown> }> = [];
vi.mock("../logging/logSystemEvent.js", () => ({
  logSystemEvent: vi.fn(async (level: string, _scope: string, message: string, metadata?: Record<string, unknown>) => {
    logged.push({ level, message, metadata });
  }),
}));

// No database: the account's project is taken as given rather than looked up (see project/context.ts).
vi.mock("../project/context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/context.js")>()),
  withAccountProject: async <T,>(_accountId: string, fn: () => Promise<T>) => fn(),
}));

afterEach(() => {
  logged.length = 0;
  vi.useRealTimers();
});

async function load() {
  const { syncGroupsWithTimeoutAndRetry } = await import("../commands/commandProcessor.js");
  const { SessionNotReadyError } = await import("../provider/WhatsAppProvider.js");
  return { syncGroupsWithTimeoutAndRetry, SessionNotReadyError };
}

describe("group sync retries", () => {
  it("does not retry a session that is not ready, and reports its reason", async () => {
    const { syncGroupsWithTimeoutAndRetry, SessionNotReadyError } = await load();
    const getGroups = vi.fn(async () => {
      throw new SessionNotReadyError("This account was logged out on the phone.");
    });

    await expect(
      syncGroupsWithTimeoutAndRetry("acc-not-ready", { getGroups } as never),
    ).rejects.toThrow("logged out on the phone");

    expect(getGroups).toHaveBeenCalledTimes(1);
    expect(logged.map((entry) => entry.message)).not.toContain("GROUP_SYNC_RETRY");
    expect(logged.at(-1)).toMatchObject({
      level: "ERROR",
      message: "GROUP_SYNC_FAILED",
      metadata: { error: "This account was logged out on the phone." },
    });
  });

  it("still retries an ordinary failure, which may clear on its own", async () => {
    vi.useFakeTimers();
    const { syncGroupsWithTimeoutAndRetry } = await load();
    const getGroups = vi.fn(async () => {
      throw new Error("Execution context was destroyed");
    });

    const run = syncGroupsWithTimeoutAndRetry("acc-transient", { getGroups } as never);
    const settled = run.catch((err: Error) => err);
    await vi.advanceTimersByTimeAsync(45_000);

    expect((await settled) as Error).toBeInstanceOf(Error);
    expect(getGroups).toHaveBeenCalledTimes(3);
  });

  it("after a connect, a read still running past its bound is neither retried nor FAILED — the arrival passes take over", async () => {
    const { syncGroupsWithTimeoutAndRetry, GROUP_ARRIVAL_SETTINGS, GroupListStillLoadingError } = await import("../commands/commandProcessor.js");
    const saved = GROUP_ARRIVAL_SETTINGS.readTimeoutMs;
    GROUP_ARRIVAL_SETTINGS.readTimeoutMs = 50;
    try {
      // A page still loading a new device's chats: the read takes far longer than the bound.
      const getGroups = vi.fn(() => new Promise((resolve) => setTimeout(() => resolve([]), 2_000)));
      await expect(syncGroupsWithTimeoutAndRetry("acc-new-device", { getGroups } as never, { afterConnect: true })).rejects.toBeInstanceOf(
        GroupListStillLoadingError,
      );
      expect(getGroups).toHaveBeenCalledTimes(1);
      const messages = logged.map((entry) => entry.message);
      expect(messages).toContain("GROUP_LIST_STILL_LOADING");
      expect(messages).not.toContain("GROUP_SYNC_RETRY");
      expect(messages).not.toContain("GROUP_SYNC_TIMEOUT");
      expect(logged.some((entry) => entry.level === "ERROR")).toBe(false);
    } finally {
      GROUP_ARRIVAL_SETTINGS.readTimeoutMs = saved;
    }
  });

});

