import "./helpers/requireTestDatabase.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma, inIsp } from "./helpers/projectFixtures.js";
import {
  cancelGroupSync,
  GROUP_ARRIVAL_SETTINGS,
  groupArrivalDecision,
  isGrowthPass,
  resyncAndCatchUpAfterConnect,
  syncGroups,
} from "../commands/commandProcessor.js";
import { MockProvider } from "./mockProvider.js";

/**
 * Arrival settling counts BOTH new groups and the size of the list WhatsApp returns.
 *
 * The bug: an account that already has its groups in the database creates nothing while a freshly
 * connected session delivers its chat list (492 → 900 → 1,400 → 1,900 are all "0 new"), so counting
 * only new groups settled after three passes with the list still filling. The fix tracks the largest
 * list returned since the connect (`maxReturned`) as well.
 */

const accounts: string[] = [];
const saved = { ...GROUP_ARRIVAL_SETTINGS };

const fullRoster = (tag: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({ whatsappGroupId: `${tag}-${i}-1600000000@g.us`, name: `Group ${tag} ${i}` }));

async function newAccount() {
  const a = await prisma.whatsAppAccount.create({ data: { label: `Arrival ${randomUUID()}`, status: "CONNECTED" } });
  accounts.push(a.id);
  return a.id;
}

/** A provider whose Nth read returns the first `counts[N]` groups of one roster (the last count repeats). */
function sequencedProvider(roster: ReturnType<typeof fullRoster>, counts: number[]) {
  const provider = new MockProvider();
  const state = { reads: 0 };
  provider.getGroups = async () => {
    const n = counts[Math.min(state.reads, counts.length - 1)]!;
    state.reads += 1;
    return roster.slice(0, n);
  };
  return { provider, state };
}

const waitFor = async (check: () => Promise<boolean>, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

const settledLog = (accountId: string) =>
  prisma.systemLog.findFirst({ where: { message: "GROUP_ARRIVAL_SETTLED", metadata: { path: ["accountId"], equals: accountId } } });
const completedCount = (accountId: string) =>
  prisma.systemLog.count({ where: { message: "GROUP_SYNC_COMPLETED", metadata: { path: ["accountId"], equals: accountId } } });

beforeEach(() => {
  GROUP_ARRIVAL_SETTINGS.intervalMs = 30;
});

afterEach(async () => {
  Object.assign(GROUP_ARRIVAL_SETTINGS, saved);
  await prisma.whatsAppGroup.deleteMany({ where: { accountId: { in: accounts } } });
  await prisma.whatsAppAccount.deleteMany({ where: { id: { in: accounts } } });
  accounts.length = 0;
});

describe("what counts as growth (pure)", () => {
  it("a bigger list than ever seen is growth even with no new group", () => {
    expect(isGrowthPass(0, 900, 492)).toBe(true);
    expect(isGrowthPass(0, 1400, 900)).toBe(true);
  });

  it("the same list with no new group is stable", () => {
    expect(isGrowthPass(0, 1900, 1900)).toBe(false);
  });

  it("the same size but a new group is still growth", () => {
    expect(isGrowthPass(3, 1900, 1900)).toBe(true);
  });

  it("a smaller list is neither growth nor a reason to do anything else", () => {
    expect(isGrowthPass(0, 1600, 1900)).toBe(false);
  });

  it("settles only after the usual number of stable passes", () => {
    const settings = { stableReads: 3, maxMs: 10_000 };
    // 492 → 900 → 1,400 → 1,850 → 1,900 → 1,900 ×3 (growth flags)
    expect(groupArrivalDecision([true, true, true, true], 0, settings)).toBe("CONTINUE");
    expect(groupArrivalDecision([true, true, true, true, true, false, false], 0, settings)).toBe("CONTINUE");
    expect(groupArrivalDecision([true, true, true, true, true, false, false, false], 0, settings)).toBe("SETTLED");
  });
});

describe("an existing account whose list is still arriving", () => {
  it("492 → 900 → 1,400 → 1,900 with zero new groups every pass does NOT settle early; it settles after three stable passes; its settings are untouched", async () => {
    const id = await newAccount();
    const tag = randomUUID().slice(0, 6);
    const roster = fullRoster(tag, 1900);

    // The database already has all 1,900, one of them configured by a person.
    const seed = new MockProvider();
    seed.getGroups = async () => roster;
    await syncGroups(id, seed);
    const configured = await prisma.whatsAppGroup.findFirstOrThrow({ where: { accountId: id, whatsappGroupId: roster[5]!.whatsappGroupId } });
    await prisma.whatsAppGroup.update({ where: { id: configured.id }, data: { isMonitored: true, aiAutomationEnabled: true, aiAutomationExcluded: true, priority: "P1" } });

    // Read 1 (the connect's own sync): 492. Then 900, 1,400, 1,900, 1,900 ×3.
    const { provider, state } = sequencedProvider(roster, [492, 900, 1400, 1900, 1900, 1900, 1900]);
    await inIsp(async () => resyncAndCatchUpAfterConnect(id, provider, "test"));
    expect(await waitFor(async () => (await settledLog(id)) !== null)).toBe(true);

    const log = await settledLog(id);
    const meta = log!.metadata as { passes: number; outcome: string; timeline: Array<{ total: number; new: number }> };
    // 3 growth passes (900, 1,400, 1,900) then 3 stable ones. The old logic settled after pass 3.
    expect(meta.passes).toBe(6);
    expect(meta.outcome).toBe("SETTLED");
    expect(meta.timeline.map((t) => t.total)).toEqual([492, 900, 1400, 1900]);
    expect(meta.timeline.every((t, i) => i === 0 || t.new === 0)).toBe(true); // growth with zero new groups

    // One full reconciliation, which completes the list and clears the warning.
    expect(await waitFor(async () => (await prisma.whatsAppAccount.findUniqueOrThrow({ where: { id } })).groupSyncStatus === "COMPLETED")).toBe(true);
    expect(state.reads).toBe(8);
    expect(await prisma.whatsAppAccount.findUniqueOrThrow({ where: { id } })).toMatchObject({ groupSyncDiscovered: 1900 });
    expect(await prisma.whatsAppGroup.count({ where: { accountId: id, isActive: true } })).toBe(1900);
    expect(await prisma.whatsAppGroup.findUniqueOrThrow({ where: { id: configured.id } })).toMatchObject({
      isMonitored: true,
      aiAutomationEnabled: true,
      aiAutomationExcluded: true,
      priority: "P1",
    });
  });

  it("1,900 → 1,900 → 1,900 with zero new groups settles after the usual number of stable passes — and the full reconciliation runs exactly once", async () => {
    const id = await newAccount();
    const roster = fullRoster(randomUUID().slice(0, 6), 1900);
    const seed = new MockProvider();
    seed.getGroups = async () => roster;
    await syncGroups(id, seed);

    const { provider, state } = sequencedProvider(roster, [1900]);
    await inIsp(async () => resyncAndCatchUpAfterConnect(id, provider, "test"));
    expect(await waitFor(async () => (await settledLog(id)) !== null)).toBe(true);

    // Baseline 1,900 from the connect's own sync, so all three passes are stable: 3 passes.
    expect(((await settledLog(id))!.metadata as { passes: number }).passes).toBe(3);

    // Initial sync + exactly one final reconciliation = two COMPLETED events, and no third.
    expect(await waitFor(async () => (await completedCount(id)) === 2)).toBe(true);
    const readsAtSettle = state.reads;
    await new Promise((r) => setTimeout(r, 400));
    expect(await completedCount(id)).toBe(2);
    expect(state.reads).toBe(readsAtSettle);
    expect(readsAtSettle).toBe(1 + 3 + 1); // connect sync + 3 passes + the one full sync
  });

  it("a smaller list is not growth and never deactivates anything: 1,900 → 1,600 is held by the sweep guard", async () => {
    const id = await newAccount();
    const roster = fullRoster(randomUUID().slice(0, 6), 1900);
    const seed = new MockProvider();
    seed.getGroups = async () => roster;
    await syncGroups(id, seed);

    const { provider } = sequencedProvider(roster, [1900, 1600]);
    await inIsp(async () => resyncAndCatchUpAfterConnect(id, provider, "test"));
    expect(await waitFor(async () => (await settledLog(id)) !== null)).toBe(true);
    expect(await waitFor(async () => (await completedCount(id)) === 2)).toBe(true);

    expect(await prisma.whatsAppGroup.count({ where: { accountId: id, isActive: true } })).toBe(1900);
    expect(await prisma.whatsAppAccount.findUniqueOrThrow({ where: { id } })).toMatchObject({ groupSyncStatus: "PARTIAL" });
  });

  it("growth is measured against the LARGEST list seen, not the previous pass: 1,900 → 1,600 → 1,900 is a dip and a recovery, not growth", async () => {
    const id = await newAccount();
    const roster = fullRoster(randomUUID().slice(0, 6), 1900);
    const seed = new MockProvider();
    seed.getGroups = async () => roster;
    await syncGroups(id, seed);

    // Read 1 (connect sync) 1,900 sets the baseline; passes: 1,600, 1,900, 1,900, 1,900.
    const { provider } = sequencedProvider(roster, [1900, 1600, 1900, 1900, 1900]);
    await inIsp(async () => resyncAndCatchUpAfterConnect(id, provider, "test"));
    expect(await waitFor(async () => (await settledLog(id)) !== null)).toBe(true);
    // Against the previous pass the recovery to 1,900 would count as growth and need two more passes.
    expect(((await settledLog(id))!.metadata as { passes: number }).passes).toBe(3);
  });

  it("the same size but a new group each pass is not stable", async () => {
    const id = await newAccount();
    const tag = randomUUID().slice(0, 6);
    const roster = fullRoster(tag, 1010);
    const seed = new MockProvider();
    seed.getGroups = async () => roster.slice(0, 1000);
    await syncGroups(id, seed);

    // Each read returns 1,000 groups, but a different 1,000 — a window sliding over the roster.
    const provider = new MockProvider();
    let read = 0;
    provider.getGroups = async () => {
      const start = Math.min(read, 10);
      read += 1;
      return roster.slice(start, start + 1000);
    };
    await inIsp(async () => resyncAndCatchUpAfterConnect(id, provider, "test"));
    expect(await waitFor(async () => (await settledLog(id)) !== null)).toBe(true);
    // Read 1 is the connect sync (window 0). Passes 1-10 each reveal one new group; then 3 stable.
    expect(((await settledLog(id))!.metadata as { passes: number }).passes).toBe(13);
  });
});

describe("a new account", () => {
  it("0 → 100 → 500 → 1,000 still settles normally, then the one full reconciliation runs", async () => {
    const id = await newAccount();
    const roster = fullRoster(randomUUID().slice(0, 6), 1000);
    const { provider } = sequencedProvider(roster, [0, 100, 500, 1000, 1000, 1000, 1000]);
    await inIsp(async () => resyncAndCatchUpAfterConnect(id, provider, "test"));
    expect(await waitFor(async () => (await settledLog(id)) !== null)).toBe(true);
    expect(((await settledLog(id))!.metadata as { passes: number }).passes).toBe(6);
    expect(await waitFor(async () => (await prisma.whatsAppAccount.findUniqueOrThrow({ where: { id } })).groupSyncStatus === "COMPLETED")).toBe(true);
    expect(await prisma.whatsAppGroup.count({ where: { accountId: id, isActive: true } })).toBe(1000);
  });
});

describe("cancellation is unchanged", () => {
  it("a Logout/Reconnect during the arrival stops the passes and never records a settle", async () => {
    const id = await newAccount();
    const roster = fullRoster(randomUUID().slice(0, 6), 1900);
    const seed = new MockProvider();
    seed.getGroups = async () => roster;
    await syncGroups(id, seed);
    GROUP_ARRIVAL_SETTINGS.intervalMs = 60;

    const { provider, state } = sequencedProvider(roster, [492, 900, 1400, 1900, 1900, 1900, 1900, 1900]);
    await inIsp(async () => resyncAndCatchUpAfterConnect(id, provider, "test"));
    // Wait for the arrival to be visibly under way (growth with zero new groups is recorded as RUNNING).
    expect(await waitFor(async () => state.reads >= 3)).toBe(true);
    await inIsp(() => cancelGroupSync(id, "Stopped because the account was logged out."));
    const readsAtCancel = state.reads;
    await new Promise((r) => setTimeout(r, 500));
    expect(state.reads).toBe(readsAtCancel);
    expect(await settledLog(id)).toBeNull();
    expect((await prisma.whatsAppAccount.findUniqueOrThrow({ where: { id } })).groupSyncStatus).not.toBe("COMPLETED");
  });
});
