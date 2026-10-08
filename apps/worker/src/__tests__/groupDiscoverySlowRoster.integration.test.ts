import "./helpers/requireTestDatabase.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma, inIsp } from "./helpers/projectFixtures.js";
import {
  cancelGroupSync,
  GROUP_ARRIVAL_SETTINGS,
  groupArrivalDecision,
  resyncAndCatchUpAfterConnect,
  startCommandProcessor,
  syncGroups,
  syncGroupsWithTimeoutAndRetry,
} from "../commands/commandProcessor.js";
import { MockProvider } from "./mockProvider.js";
import { GroupListNotReadyError } from "../provider/WhatsAppProvider.js";
import { ProviderRegistry } from "../provider/ProviderRegistry.js";

/**
 * A second number linked while the first keeps working (production, 7 Oct 2026): the Lead account
 * came up CONNECTED, sending and receiving, while its group sync ended "timed out after 150000ms".
 *
 * Why: the post-connect sync read the list with three 150 s attempts (about eight minutes) before
 * the arrival passes could even start, on a page still loading the chats the phone was sending; an
 * empty first read also fell back to OpenWA's getAllGroups(), which serialises every chat. Now the
 * post-connect read is bounded (`readTimeoutMs`), a read past it means "still loading" — the account
 * stays syncing, nothing is retried or failed — and the arrival passes keep reading until the
 * returned list is stable, then the protected FULL sync runs.
 *
 * Every read here comes from a scripted provider: the Nth read returns the first `count` groups of
 * one roster, optionally after `delayMs`, or throws.
 */

const accounts: string[] = [];
const saved = { ...GROUP_ARRIVAL_SETTINGS };

type Step = { count: number; delayMs?: number } | { throws: string };

const roster = (tag: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({ whatsappGroupId: `${tag}-${i}-1700000000@g.us`, name: `Group ${tag} ${i}` }));

async function newAccount() {
  const a = await prisma.whatsAppAccount.create({ data: { label: `Discovery ${randomUUID()}`, status: "CONNECTED" } });
  accounts.push(a.id);
  return a.id;
}

function scripted(groups: ReturnType<typeof roster>, steps: Step[]) {
  const provider = new MockProvider();
  const state = { reads: 0 };
  provider.getGroups = async () => {
    const step = steps[Math.min(state.reads, steps.length - 1)]!;
    state.reads += 1;
    if ("throws" in step) throw new Error(step.throws);
    if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
    return groups.slice(0, step.count);
  };
  return { provider, state };
}

const waitFor = async (check: () => Promise<boolean>, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

const logs = (accountId: string, message: string) =>
  prisma.systemLog.count({ where: { message, metadata: { path: ["accountId"], equals: accountId } } });
const settled = (accountId: string) => logs(accountId, "GROUP_ARRIVAL_SETTLED").then((n) => n > 0);
const account = (id: string) => prisma.whatsAppAccount.findUniqueOrThrow({ where: { id } });
const activeCount = (accountId: string) => prisma.whatsAppGroup.count({ where: { accountId, isActive: true } });
const finished = async (id: string) => {
  const a = await account(id);
  return (await settled(id)) && (a.groupSyncStatus === "COMPLETED" || a.groupSyncStatus === "PARTIAL");
};

beforeEach(() => {
  GROUP_ARRIVAL_SETTINGS.intervalMs = 30;
  GROUP_ARRIVAL_SETTINGS.readTimeoutMs = 120;
});

afterEach(async () => {
  Object.assign(GROUP_ARRIVAL_SETTINGS, saved);
  for (const id of accounts) await cancelGroupSync(id, "test cleanup").catch(() => undefined);
  await prisma.whatsAppGroup.deleteMany({ where: { accountId: { in: accounts } } });
  await prisma.whatsAppAccount.deleteMany({ where: { id: { in: accounts } } });
  accounts.length = 0;
});

describe("a read that has not finished is no evidence (pure)", () => {
  it("a still-loading pass breaks a stable run instead of extending it", () => {
    const settings = { stableReads: 3, maxMs: 10_000 };
    expect(groupArrivalDecision([true, false, false, null], 0, settings)).toBe("CONTINUE");
    expect(groupArrivalDecision([null, null, null], 0, settings)).toBe("CONTINUE");
    expect(groupArrivalDecision([true, null, false, false, false], 0, settings)).toBe("SETTLED");
    expect(groupArrivalDecision([null, null, null], 10_000, settings)).toBe("GAVE_UP");
  });
});

describe("a newly connected second account", () => {
  it("1/6. starts with a partial roster (nothing at all yet), saves each batch as it arrives, and completes once the list is stable", async () => {
    const id = await newAccount();
    const groups = roster(randomUUID().slice(0, 6), 800);
    const { provider } = scripted(groups, [{ count: 0 }, { count: 300 }, { count: 800 }, { count: 800 }]);

    await inIsp(async () => resyncAndCatchUpAfterConnect(id, provider, "test"));
    expect(await waitFor(() => finished(id))).toBe(true);

    expect(await activeCount(id)).toBe(800);
    const a = await account(id);
    expect(a).toMatchObject({ groupSyncStatus: "COMPLETED", groupSyncDiscovered: 800, groupSyncError: null });
    expect(await logs(id, "GROUP_SYNC_FAILED")).toBe(0);
    expect(await logs(id, "GROUP_SYNC_TIMEOUT")).toBe(0);
  });

  it("3. a read slower than normal: the account stays SYNCING (never FAILED), nothing is retried, and the passes carry on to completion", async () => {
    const id = await newAccount();
    const groups = roster(randomUUID().slice(0, 6), 600);
    // The connect's read and the first pass's read both take longer than readTimeoutMs.
    const { provider } = scripted(groups, [
      { count: 0, delayMs: 400 },
      { count: 250, delayMs: 400 },
      { count: 600 },
      { count: 600 },
    ]);

    await inIsp(async () => resyncAndCatchUpAfterConnect(id, provider, "test"));
    expect(
      await waitFor(async () => {
        const a = await account(id);
        return a.groupSyncStatus === "RUNNING" && /still loading|Waiting for WhatsApp/.test(a.groupSyncStage ?? "");
      }),
    ).toBe(true);
    expect(await logs(id, "GROUP_LIST_STILL_LOADING")).toBe(1);

    expect(await waitFor(() => finished(id))).toBe(true);
    expect(await activeCount(id)).toBe(600);
    expect((await account(id)).groupSyncStatus).toBe("COMPLETED");
    // The slow connect read was handed over, not retried: no retry, no timeout, no failure logged.
    expect(await logs(id, "GROUP_SYNC_RETRY")).toBe(0);
    expect(await logs(id, "GROUP_SYNC_TIMEOUT")).toBe(0);
    expect(await logs(id, "GROUP_SYNC_FAILED")).toBe(0);
  });

  it("4. a temporary failure of one read is retried by the next pass; partial progress is kept", async () => {
    const id = await newAccount();
    const groups = roster(randomUUID().slice(0, 6), 150);
    const { provider, state } = scripted(groups, [{ count: 100 }, { throws: "Execution context was destroyed" }, { count: 150 }, { count: 150 }]);

    await inIsp(async () => resyncAndCatchUpAfterConnect(id, provider, "test"));
    // After the failing pass the first 100 are still there.
    expect(await waitFor(async () => state.reads >= 2)).toBe(true);
    expect(await activeCount(id)).toBeGreaterThanOrEqual(100);

    expect(await waitFor(() => finished(id))).toBe(true);
    expect(await activeCount(id)).toBe(150);
    expect((await account(id)).groupSyncStatus).toBe("COMPLETED");
  });

  it("2. existing groups already in the database while the returned count keeps rising: not settled early, nothing deactivated on the way", async () => {
    const id = await newAccount();
    const groups = roster(randomUUID().slice(0, 6), 1000);
    const seed = new MockProvider();
    seed.getGroups = async () => groups;
    await syncGroups(id, seed);

    const { provider } = scripted(groups, [{ count: 200, delayMs: 200 }, { count: 500 }, { count: 800 }, { count: 1000 }, { count: 1000 }]);
    const minActive = { value: Infinity };
    const sampler = setInterval(() => {
      void activeCount(id).then((n) => (minActive.value = Math.min(minActive.value, n)));
    }, 20);
    try {
      await inIsp(async () => resyncAndCatchUpAfterConnect(id, provider, "test"));
      expect(await waitFor(() => finished(id))).toBe(true);
    } finally {
      clearInterval(sampler);
    }
    expect(minActive.value).toBe(1000);
    const log = await prisma.systemLog.findFirstOrThrow({ where: { message: "GROUP_ARRIVAL_SETTLED", metadata: { path: ["accountId"], equals: id } } });
    // 500, 800 and 1,000 were growth (no new group in any of them); three stable passes after that.
    expect((log.metadata as { passes: number }).passes).toBeGreaterThanOrEqual(6);
  });

  it("5. a partial roster never deactivates existing groups — not during the passes, not in the final sync", async () => {
    const id = await newAccount();
    const groups = roster(randomUUID().slice(0, 6), 120);
    const seed = new MockProvider();
    seed.getGroups = async () => groups;
    await syncGroups(id, seed);

    // WhatsApp only ever hands this session 10 of its 120 groups.
    const { provider } = scripted(groups, [{ count: 10, delayMs: 300 }, { count: 10 }]);
    await inIsp(async () => resyncAndCatchUpAfterConnect(id, provider, "test"));
    expect(await waitFor(() => finished(id))).toBe(true);

    expect(await activeCount(id)).toBe(120);
    const a = await account(id);
    expect(a.groupSyncStatus).toBe("PARTIAL");
    expect(a.groupSyncDeactivated).toBe(0);
    expect(await logs(id, "GROUP_SYNC_SWEEP_HELD")).toBeGreaterThan(0);
  });

  it("7. a Logout while the list is still loading stops everything: CANCELLED, no more reads, nothing written afterwards", async () => {
    const id = await newAccount();
    const groups = roster(randomUUID().slice(0, 6), 300);
    const { provider, state } = scripted(groups, [{ count: 0, delayMs: 400 }, { count: 0, delayMs: 400 }, { count: 300 }]);

    await inIsp(async () => resyncAndCatchUpAfterConnect(id, provider, "test"));
    expect(await waitFor(async () => (await account(id)).groupSyncStatus === "RUNNING")).toBe(true);
    await inIsp(() => cancelGroupSync(id, "Stopped because the account was logged out."));

    const readsAtCancel = state.reads;
    await new Promise((r) => setTimeout(r, 1_200));
    expect(state.reads).toBeLessThanOrEqual(readsAtCancel + 1); // at most the read already under way
    expect(await activeCount(id)).toBe(0);
    expect(await account(id)).toMatchObject({ groupSyncStatus: "CANCELLED", groupSyncError: "Stopped because the account was logged out." });
    expect(await settled(id)).toBe(false);
  });
});

describe("8. the primary / an established account is unchanged", () => {
  it("a list that reads quickly is synced at the connect exactly as before: one FULL sync, completed, nothing 'still loading'", async () => {
    const id = await newAccount();
    const groups = roster(randomUUID().slice(0, 6), 500);
    const seed = new MockProvider();
    seed.getGroups = async () => groups;
    await syncGroups(id, seed);

    const { provider, state } = scripted(groups, [{ count: 500 }]);
    await inIsp(async () => resyncAndCatchUpAfterConnect(id, provider, "test"));
    expect(await waitFor(async () => (await logs(id, "GROUP_SYNC_COMPLETED")) >= 1)).toBe(true);
    expect((await account(id)).groupSyncStatus).toBe("COMPLETED");
    expect(state.reads).toBeGreaterThanOrEqual(1);
    expect(await logs(id, "GROUP_LIST_STILL_LOADING")).toBe(0);
    expect(await activeCount(id)).toBe(500);
  });

  it("an ordinary sync (a Resync press, the settled full sync) has no read bound: a read slower than readTimeoutMs still completes", async () => {
    const id = await newAccount();
    const groups = roster(randomUUID().slice(0, 6), 40);
    const { provider } = scripted(groups, [{ count: 40, delayMs: 400 }]);

    expect(await syncGroupsWithTimeoutAndRetry(id, provider)).toBe(40);
    expect((await account(id)).groupSyncStatus).toBe("COMPLETED");
    expect(await logs(id, "GROUP_LIST_STILL_LOADING")).toBe(0);
  });
});

describe("empty, not ready, and hung reads (8 Oct 2026)", () => {
  it("empty reads before any group has ever been listed never settle the sync — it waits for the roster to start arriving", async () => {
    const id = await newAccount();
    const groups = roster(randomUUID().slice(0, 6), 300);
    const live = { count: 0, reads: 0 };
    const provider = new MockProvider();
    provider.getGroups = async () => {
      live.reads += 1;
      return groups.slice(0, live.count);
    };

    await inIsp(async () => resyncAndCatchUpAfterConnect(id, provider, "test"));
    // Well past three passes' worth of empty reads.
    expect(await waitFor(async () => live.reads >= 8)).toBe(true);
    expect(await settled(id)).toBe(false);
    const meanwhile = await account(id);
    // Not "Groups synced — 0 groups": the connect sync handed over instead of completing on nothing.
    expect(meanwhile.groupSyncStatus).toBe("RUNNING");
    expect(await logs(id, "GROUP_SYNC_COMPLETED")).toBe(0);

    // The phone starts sending groups: the passes pick them up and settle on the real list.
    live.count = 300;
    expect(await waitFor(() => finished(id))).toBe(true);
    expect(await activeCount(id)).toBe(300);
    expect((await account(id)).groupSyncDiscovered).toBe(300);
  });

  it("'not ready' from the provider (an empty chat store) is still loading: retried by the passes, never FAILED", async () => {
    const id = await newAccount();
    const groups = roster(randomUUID().slice(0, 6), 120);
    const provider = new MockProvider();
    let reads = 0;
    provider.getGroups = async () => {
      reads += 1;
      if (reads <= 3) throw new GroupListNotReadyError("WhatsApp Web has not received this number's chats from the phone yet.");
      return groups;
    };

    await inIsp(async () => resyncAndCatchUpAfterConnect(id, provider, "test"));
    expect(await waitFor(() => finished(id))).toBe(true);
    expect(await activeCount(id)).toBe(120);
    expect(await logs(id, "GROUP_SYNC_FAILED")).toBe(0);
    expect(await logs(id, "GROUP_SYNC_RETRY")).toBe(0);
  });

  it("a genuinely hung read: the read limit releases the sync flow, the next pass reads a fresh snapshot, and the sync completes", async () => {
    const id = await newAccount();
    const groups = roster(randomUUID().slice(0, 6), 90);
    const provider = new MockProvider();
    let reads = 0;
    provider.getGroups = () => {
      reads += 1;
      // The connect's read never answers at all.
      return reads === 1 ? new Promise<never>(() => undefined) : Promise.resolve(groups);
    };

    await inIsp(async () => resyncAndCatchUpAfterConnect(id, provider, "test"));
    expect(await waitFor(() => finished(id))).toBe(true);
    expect(reads).toBeGreaterThan(1);
    expect(await activeCount(id)).toBe(90);
    expect(await logs(id, "GROUP_LIST_STILL_LOADING")).toBe(1);
    expect(await logs(id, "GROUP_SYNC_FAILED")).toBe(0);
  });
});

describe("a Resync pressed while the connect's read is still loading (8 Oct 2026)", () => {
  it("joins that sync and settles DONE ('still loading'), never FAILED — the arrival passes are syncing the list", async () => {
    // Found by the full suite: the RESYNC joined the connect's in-flight sync, received its
    // "still loading" hand-over, and was recorded FAILED although nothing had failed.
    const id = await newAccount();
    const groups = roster(randomUUID().slice(0, 6), 60);
    const { provider } = scripted(groups, [{ count: 0, delayMs: 500 }, { count: 60 }]);
    const registry = new ProviderRegistry();
    registry.registerForTesting(id, provider);

    await inIsp(async () => resyncAndCatchUpAfterConnect(id, provider, "test"));
    const command = await prisma.workerCommand.create({ data: { type: "RESYNC_GROUPS", accountId: id } });
    const interval = startCommandProcessor(registry, 10);
    try {
      expect(
        await waitFor(async () => (await prisma.workerCommand.findUniqueOrThrow({ where: { id: command.id } })).status !== "PENDING" &&
          (await prisma.workerCommand.findUniqueOrThrow({ where: { id: command.id } })).status !== "PROCESSING"),
      ).toBe(true);
      const settledCommand = await prisma.workerCommand.findUniqueOrThrow({ where: { id: command.id } });
      expect(settledCommand.status).toBe("DONE");
      expect(settledCommand.result).toMatchObject({ stillLoading: true });
      // And the list still arrives in full.
      expect(await waitFor(() => finished(id))).toBe(true);
      expect(await activeCount(id)).toBe(60);
    } finally {
      clearInterval(interval);
      await prisma.workerCommand.deleteMany({ where: { accountId: id } });
    }
  });
});

