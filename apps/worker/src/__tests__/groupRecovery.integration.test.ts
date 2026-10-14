import "./helpers/requireTestDatabase.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "./helpers/projectFixtures.js";
import { cancelGroupSync, runGroupRecoveryPass } from "../commands/commandProcessor.js";
import {
  backoffAfter,
  checkGroupRecovery,
  GROUP_RECOVERY_SETTINGS,
  groupRecoverySchedule,
  resetGroupRecoveryState,
  type MachineLoad,
} from "../commands/groupRecovery.js";
import { ProviderRegistry } from "../provider/ProviderRegistry.js";
import { GroupListNotReadyError } from "../provider/WhatsAppProvider.js";
import { MockProvider } from "./mockProvider.js";

/**
 * Group recovery: an account left with an unfinished group list is read again, slowly and safely.
 *
 * Reproduced in the lab first (14 Oct 2026): a session the worker restarted after its own health
 * check failed under CPU load came back with 477 of its 573 known groups, the arrival passes
 * settled there, and the account sat CONNECTED with `groupSyncStatus = PARTIAL` while nothing ever
 * read the list again. These tests pin the loop that closes that gap, and above all what it must
 * never do: deactivate a group, activate one WhatsApp does not list, touch another account, read
 * while one is already in flight, call a historical inactive group "pending", or believe a read
 * that never really happened.
 */

// The suite shares a machine with a live browser during lab runs; a cold first connection is slow.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const accounts: string[] = [];
const calm = (): MachineLoad => ({ loadPerCpu: 0, eventLoopDelayMs: 0 });
const MIN = 60_000;
const SENTINEL_DISCOVERED = 777; // a recorded count a bad read must not overwrite

const gid = (tag: string, i: number) => `${tag}-${i}-1600000000@g.us`;

async function newAccount(
  opts: {
    status?: "CONNECTED" | "DISCONNECTED";
    phoneNumber?: string | null;
    sync?: "FAILED" | "PARTIAL" | "COMPLETED" | null;
    connectedAt?: Date;
  } = {},
) {
  const account = await prisma.whatsAppAccount.create({
    data: {
      label: `Recovery ${randomUUID()}`,
      status: opts.status ?? "CONNECTED",
      // digits only — see CLAUDE.md on test phone numbers
      phoneNumber: opts.phoneNumber === undefined ? `8801${Math.floor(Math.random() * 1e9).toString().padStart(9, "0")}` : opts.phoneNumber,
      // Long ago by default: the arrival watcher owns the first minutes after a connect.
      lastConnectedAt: opts.connectedAt ?? new Date(0),
      groupSyncStatus: opts.sync === undefined ? "PARTIAL" : opts.sync,
      groupSyncDiscovered: SENTINEL_DISCOVERED,
    },
  });
  accounts.push(account.id);
  return account.id;
}

async function seedGroups(accountId: string, tag: string, spec: Array<{ i: number; active: boolean }>) {
  await prisma.whatsAppGroup.createMany({
    data: spec.map(({ i, active }) => ({ accountId, whatsappGroupId: gid(tag, i), name: `G ${tag} ${i}`, isActive: active })),
  });
}

const activeOf = async (accountId: string, tag: string, i: number) =>
  (await prisma.whatsAppGroup.findUniqueOrThrow({ where: { accountId_whatsappGroupId: { accountId, whatsappGroupId: gid(tag, i) } } })).isActive;
const accountRow = (id: string) => prisma.whatsAppAccount.findUniqueOrThrow({ where: { id } });
const rowCount = (id: string) => prisma.whatsAppGroup.count({ where: { accountId: id } });

/** A provider that lists exactly these group indexes, counting how many reads it served. */
function listing(tag: string, indexes: number[]) {
  const provider = new MockProvider();
  const state = { reads: 0, indexes };
  provider.getGroups = async () => {
    state.reads += 1;
    return state.indexes.map((i) => ({ whatsappGroupId: gid(tag, i), name: `G ${tag} ${i}` }));
  };
  return { provider, state };
}

let registry: ProviderRegistry;
const clock = { t: 10_000_000 };
const tick = () => checkGroupRecovery(registry, { now: () => clock.t, load: calm });
/** Waits out the first-sighting grace so the next tick is the one that reads. */
async function pastGrace(accountId: string) {
  await tick();
  expect(groupRecoverySchedule(accountId)).not.toBeNull();
  clock.t += backoffAfter(0);
}

beforeEach(() => {
  registry = new ProviderRegistry();
  resetGroupRecoveryState();
  clock.t = 10_000_000;
});

afterEach(async () => {
  resetGroupRecoveryState();
  await prisma.systemLog.deleteMany({ where: { message: { in: ["GROUP_RECOVERY_PASS", "GROUP_RECOVERY_FAILED"] } } });
  await prisma.whatsAppGroup.deleteMany({ where: { accountId: { in: accounts } } });
  await prisma.whatsAppAccount.deleteMany({ where: { id: { in: accounts } } });
  accounts.length = 0;
});

describe("a partial list is recovered without deactivating or inventing anything", () => {
  it("switches on inactive groups WhatsApp lists; leaves unlisted ones exactly as they were; stays PARTIAL while an ACTIVE group is missing", async () => {
    const id = await newAccount({ sync: "PARTIAL" });
    const tag = randomUUID().slice(0, 6);
    // 0-3 listed (1 and 2 inactive), 4-5 unlisted and inactive (historical), 6 unlisted but ACTIVE.
    await seedGroups(id, tag, [
      { i: 0, active: true }, { i: 1, active: false }, { i: 2, active: false }, { i: 3, active: true },
      { i: 4, active: false }, { i: 5, active: false }, { i: 6, active: true },
    ]);
    const { provider } = listing(tag, [0, 1, 2, 3]);
    registry.registerForTesting(id, provider);

    await pastGrace(id);
    const report = await tick();

    // Only the ACTIVE group the list lacks is pending work; the two historical inactive ones are not.
    expect(report).toMatchObject({ ran: true, accountId: id, result: "RECOVERED", pending: 1 });
    expect(await activeOf(id, tag, 1)).toBe(true);
    expect(await activeOf(id, tag, 2)).toBe(true);
    expect(await activeOf(id, tag, 4)).toBe(false);
    expect(await activeOf(id, tag, 5)).toBe(false);
    expect(await activeOf(id, tag, 6)).toBe(true); // never switched off by a recovery
    expect(await rowCount(id)).toBe(7);
    const row = await accountRow(id);
    expect(row).toMatchObject({ groupSyncStatus: "PARTIAL", groupSyncDiscovered: 4 });
    expect(row.groupSyncError).toMatch(/1 group\(s\) that were active/);
  });

  it("completes, and stops looking, once no active group is missing", async () => {
    const id = await newAccount({ sync: "FAILED" });
    const tag = randomUUID().slice(0, 6);
    await seedGroups(id, tag, [{ i: 0, active: true }, { i: 1, active: false }, { i: 2, active: false }]);
    const { provider, state } = listing(tag, [0, 1, 2]);
    registry.registerForTesting(id, provider);

    await pastGrace(id);
    expect(await tick()).toMatchObject({ result: "RECOVERED", pending: 0 });
    expect(await prisma.whatsAppGroup.count({ where: { accountId: id, isActive: true } })).toBe(3);
    expect(await accountRow(id)).toMatchObject({ groupSyncStatus: "COMPLETED", groupSyncError: null });
    expect(groupRecoverySchedule(id)).toBeNull();

    clock.t += 10 * 60 * MIN;
    expect(await tick()).toMatchObject({ ran: false });
    expect(state.reads).toBe(1);
  });

  it("saves a group WhatsApp lists that this account has never had (the list is still arriving)", async () => {
    const id = await newAccount({ sync: "PARTIAL" });
    const tag = randomUUID().slice(0, 6);
    await seedGroups(id, tag, [{ i: 0, active: true }]);
    const { provider } = listing(tag, [0, 1, 2]);
    registry.registerForTesting(id, provider);

    await pastGrace(id);
    await tick();
    expect(await rowCount(id)).toBe(3);
  });
});

describe("historical inactive groups are not pending work", () => {
  it("a COMPLETED account whose inactive groups are absent from the live list stays COMPLETED, and is verified only a bounded number of times", async () => {
    const id = await newAccount({ sync: "COMPLETED" });
    const tag = randomUUID().slice(0, 6);
    await seedGroups(id, tag, [{ i: 0, active: true }, { i: 1, active: true }, { i: 2, active: false }, { i: 3, active: false }]);
    const { provider, state } = listing(tag, [0, 1]); // 2 and 3 were left long ago
    registry.registerForTesting(id, provider);

    for (let n = 0; n < 40; n += 1) {
      clock.t += 7 * 60 * MIN; // always due
      await tick();
    }

    expect(state.reads).toBe(GROUP_RECOVERY_SETTINGS.verifyMaxReads);
    expect(await accountRow(id)).toMatchObject({ groupSyncStatus: "COMPLETED", groupSyncError: null, groupSyncDiscovered: SENTINEL_DISCOVERED });
    expect(await activeOf(id, tag, 2)).toBe(false);
    expect(await activeOf(id, tag, 3)).toBe(false);
    expect(await rowCount(id)).toBe(4);
  });

  it("a COMPLETED account whose inactive groups ARE in the live list gets them back, and stays COMPLETED", async () => {
    const id = await newAccount({ sync: "COMPLETED" });
    const tag = randomUUID().slice(0, 6);
    await seedGroups(id, tag, [{ i: 0, active: true }, { i: 1, active: false }, { i: 2, active: false }, { i: 3, active: false }]);
    const { provider } = listing(tag, [0, 1, 2]); // 3 is still not listed
    registry.registerForTesting(id, provider);

    await pastGrace(id);
    expect(await tick()).toMatchObject({ result: "RECOVERED" });

    expect(await activeOf(id, tag, 1)).toBe(true);
    expect(await activeOf(id, tag, 2)).toBe(true);
    expect(await activeOf(id, tag, 3)).toBe(false);
    expect(await accountRow(id)).toMatchObject({ groupSyncStatus: "COMPLETED", groupSyncError: null, groupSyncDiscovered: SENTINEL_DISCOVERED });
  });

  it("a find resets the verification: a group that shows up late is still caught", async () => {
    const id = await newAccount({ sync: "COMPLETED" });
    const tag = randomUUID().slice(0, 6);
    await seedGroups(id, tag, [{ i: 0, active: true }, { i: 1, active: false }]);
    const { provider, state } = listing(tag, [0]);
    registry.registerForTesting(id, provider);

    await pastGrace(id);
    await tick();
    clock.t += 7 * 60 * MIN;
    await tick();
    expect(state.reads).toBe(2);

    state.indexes = [0, 1]; // WhatsApp delivers it at last
    clock.t += 7 * 60 * MIN;
    expect(await tick()).toMatchObject({ result: "RECOVERED" });
    expect(await activeOf(id, tag, 1)).toBe(true);
    // nothing inactive is left: no further reads, ever
    clock.t += 7 * 60 * MIN;
    await tick();
    expect(state.reads).toBe(3);
  });

  it("repeated ticks over a quiet COMPLETED account (no inactive groups) read nothing", async () => {
    const id = await newAccount({ sync: "COMPLETED" });
    const tag = randomUUID().slice(0, 6);
    await seedGroups(id, tag, [{ i: 0, active: true }, { i: 1, active: true }]);
    const { provider, state } = listing(tag, [0, 1]);
    registry.registerForTesting(id, provider);
    for (let n = 0; n < 10; n += 1) {
      clock.t += 7 * 60 * MIN;
      await tick();
    }
    expect(state.reads).toBe(0);
  });
});

describe("one account's recovery never touches another's", () => {
  it("leaves another account's copy of the same WhatsApp group alone, connected or not", async () => {
    const a = await newAccount({ sync: "PARTIAL" });
    const b = await newAccount({ status: "DISCONNECTED", sync: "PARTIAL" });
    const c = await newAccount({ sync: "COMPLETED" });
    const tag = randomUUID().slice(0, 6);
    await seedGroups(a, tag, [{ i: 0, active: false }]);
    await seedGroups(b, tag, [{ i: 0, active: false }]); // the SAME whatsappGroupId on another account
    await seedGroups(c, tag, [{ i: 0, active: false }]);
    registry.registerForTesting(a, listing(tag, [0]).provider);
    registry.registerForTesting(b, listing(tag, [0]).provider); // in the registry, but not CONNECTED in the database
    registry.registerForTesting(c, listing(`${tag}-other`, [0]).provider); // lists a DIFFERENT roster: no group of c's

    await pastGrace(a);
    await tick();
    // Give every later tick a chance to reach B as well: one read per tick means B would only be
    // read on a following one if it were wrongly eligible.
    for (let n = 0; n < 4; n += 1) {
      clock.t += backoffAfter(5);
      await tick();
    }

    expect(await activeOf(a, tag, 0)).toBe(true);
    expect(await activeOf(b, tag, 0)).toBe(false);
    expect(await activeOf(c, tag, 0)).toBe(false);
  });

  it("reads at most one account per tick, the next on the following one", async () => {
    const a = await newAccount();
    const b = await newAccount();
    const tag = randomUUID().slice(0, 6);
    await seedGroups(a, tag, [{ i: 0, active: false }]);
    await seedGroups(b, `${tag}b`, [{ i: 0, active: false }]);
    const first = listing(tag, [0]);
    const second = listing(`${tag}b`, [0]);
    registry.registerForTesting(a, first.provider);
    registry.registerForTesting(b, second.provider);

    await tick(); // first sighting of both: grace only
    clock.t += backoffAfter(0);
    await tick();
    expect(first.state.reads + second.state.reads).toBe(1);
    await tick();
    expect(first.state.reads + second.state.reads).toBe(2);
  });
});

describe("overlapping reads", () => {
  it("a second tick while a read is in flight reads nothing", async () => {
    const id = await newAccount();
    const tag = randomUUID().slice(0, 6);
    await seedGroups(id, tag, [{ i: 0, active: false }]);
    const provider = new MockProvider();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reads = 0;
    provider.getGroups = async () => {
      reads += 1;
      await gate;
      return [{ whatsappGroupId: gid(tag, 0), name: "G" }];
    };
    registry.registerForTesting(id, provider);

    await pastGrace(id);
    const inFlight = tick();
    await new Promise((r) => setTimeout(r, 50));
    const second = await tick();
    expect(second).toMatchObject({ ran: false });
    expect(reads).toBe(1);

    release();
    expect(await inFlight).toMatchObject({ result: "RECOVERED" });
    expect(await activeOf(id, tag, 0)).toBe(true);
  });

  it("the pass itself refuses to start beside another sync of the same account", async () => {
    const id = await newAccount();
    const tag = randomUUID().slice(0, 6);
    await seedGroups(id, tag, [{ i: 0, active: false }]);
    const provider = new MockProvider();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reads = 0;
    provider.getGroups = async () => {
      reads += 1;
      await gate;
      return [{ whatsappGroupId: gid(tag, 0), name: "G" }];
    };

    const first = runGroupRecoveryPass(id, provider, "RETRY");
    await new Promise((r) => setTimeout(r, 50));
    expect(await runGroupRecoveryPass(id, provider, "RETRY")).toBeNull(); // joined nothing, read nothing
    expect(reads).toBe(1);
    release();
    expect(await first).toMatchObject({ kind: "READ", pending: 0 });
  });

  it("a logout or reconnect during the read cancels it: nothing is written afterwards", async () => {
    const id = await newAccount();
    const tag = randomUUID().slice(0, 6);
    await seedGroups(id, tag, [{ i: 0, active: false }]);
    const provider = new MockProvider();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    provider.getGroups = async () => {
      await gate;
      return [{ whatsappGroupId: gid(tag, 0), name: "G" }];
    };
    registry.registerForTesting(id, provider);

    await pastGrace(id);
    const inFlight = tick();
    await new Promise((r) => setTimeout(r, 50));
    await cancelGroupSync(id, "a logout arrived");
    release();

    expect(await inFlight).toMatchObject({ result: "SKIPPED" });
    expect(await activeOf(id, tag, 0)).toBe(false);
    expect(groupRecoverySchedule(id)).toBeNull();
  });
});

describe("a read that did not really happen is unknown, never a result", () => {
  it("a provider whose client is gone (getGroups answers []) changes nothing, and the wait grows", async () => {
    const id = await newAccount({ sync: "PARTIAL" });
    const tag = randomUUID().slice(0, 6);
    await seedGroups(id, tag, [{ i: 0, active: true }, { i: 1, active: false }]);
    const provider = new MockProvider();
    provider.liveClient = false; // state label still says CONNECTED
    let reads = 0;
    provider.getGroups = async () => {
      reads += 1;
      return [];
    };
    registry.registerForTesting(id, provider);

    await pastGrace(id);
    expect(await tick()).toMatchObject({ ran: true, accountId: id, result: "UNKNOWN" });

    expect(await accountRow(id)).toMatchObject({ groupSyncStatus: "PARTIAL", groupSyncDiscovered: SENTINEL_DISCOVERED });
    expect(await activeOf(id, tag, 0)).toBe(true);
    expect(await activeOf(id, tag, 1)).toBe(false);
    expect((groupRecoverySchedule(id)!.nextAt - clock.t) / MIN).toBe(5);
    expect(reads).toBe(0); // not even asked
  });

  it("a pass on a provider that is not CONNECTED answers UNAVAILABLE and writes nothing", async () => {
    const id = await newAccount({ sync: "FAILED" });
    const tag = randomUUID().slice(0, 6);
    await seedGroups(id, tag, [{ i: 0, active: false }]);
    const { provider, state } = listing(tag, [0]);
    provider.connectionStatus = "RECONNECTING";

    expect(await runGroupRecoveryPass(id, provider, "RETRY")).toEqual({ kind: "UNKNOWN", reason: "UNAVAILABLE" });
    expect(state.reads).toBe(0);
    expect(await activeOf(id, tag, 0)).toBe(false);
    expect(await accountRow(id)).toMatchObject({ groupSyncStatus: "FAILED", groupSyncDiscovered: SENTINEL_DISCOVERED });
  });

  it("a legitimately EMPTY list is not authoritative: nothing is written and nothing is completed", async () => {
    const tag = randomUUID().slice(0, 6);
    // (a) an account that has groups on record
    const known = await newAccount({ sync: "PARTIAL" });
    await seedGroups(known, tag, [{ i: 0, active: true }, { i: 1, active: false }]);
    expect(await runGroupRecoveryPass(known, listing(tag, []).provider, "RETRY")).toEqual({ kind: "UNKNOWN", reason: "EMPTY_LIST" });
    expect(await accountRow(known)).toMatchObject({ groupSyncStatus: "PARTIAL", groupSyncDiscovered: SENTINEL_DISCOVERED });
    expect(await activeOf(known, tag, 0)).toBe(true);
    expect(await activeOf(known, tag, 1)).toBe(false);

    // (b) an account with none on record: an empty list cannot turn FAILED into COMPLETED either
    const none = await newAccount({ sync: "FAILED" });
    expect(await runGroupRecoveryPass(none, listing(`${tag}x`, []).provider, "RETRY")).toEqual({ kind: "UNKNOWN", reason: "EMPTY_LIST" });
    expect(await accountRow(none)).toMatchObject({ groupSyncStatus: "FAILED", groupSyncDiscovered: SENTINEL_DISCOVERED });
    expect(await rowCount(none)).toBe(0);
  });

  it("a provider that drops WHILE the list is being read: the result is discarded, no group is created or switched on", async () => {
    const id = await newAccount({ sync: "PARTIAL" });
    const tag = randomUUID().slice(0, 6);
    await seedGroups(id, tag, [{ i: 0, active: true }, { i: 1, active: false }]);
    const provider = new MockProvider();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    provider.getGroups = async () => {
      await gate;
      // what a dying page can still hand back: a list naming a known inactive group and a new one
      return [0, 1, 9].map((i) => ({ whatsappGroupId: gid(tag, i), name: `G ${i}` }));
    };

    const pass = runGroupRecoveryPass(id, provider, "RETRY");
    await new Promise((r) => setTimeout(r, 50));
    provider.connectionStatus = "DISCONNECTED"; // the session drops mid-read
    release();

    expect(await pass).toEqual({ kind: "UNKNOWN", reason: "UNAVAILABLE" });
    expect(await activeOf(id, tag, 1)).toBe(false);
    expect(await rowCount(id)).toBe(2); // 9 was not created
    expect(await accountRow(id)).toMatchObject({ groupSyncStatus: "PARTIAL", groupSyncDiscovered: SENTINEL_DISCOVERED });
  });
});

describe("retry and backoff", () => {
  it("waits through the first sighting, then reads, then waits longer each time nothing new arrives; a find starts over", async () => {
    const id = await newAccount();
    const tag = randomUUID().slice(0, 6);
    await seedGroups(id, tag, [{ i: 0, active: true }, { i: 1, active: true }, { i: 2, active: true }]);
    const { provider, state } = listing(tag, [0]); // two ACTIVE groups stay missing
    registry.registerForTesting(id, provider);

    expect(await tick()).toMatchObject({ ran: false }); // first sighting: no read
    expect(state.reads).toBe(0);
    clock.t += backoffAfter(0) - 1;
    await tick();
    expect(state.reads).toBe(0); // still inside the first wait

    const waits: number[] = [];
    for (let n = 0; n < 6; n += 1) {
      clock.t = groupRecoverySchedule(id)!.nextAt;
      expect(await tick()).toMatchObject({ result: "NO_CHANGE", pending: 2 });
      waits.push((groupRecoverySchedule(id)!.nextAt - clock.t) / MIN);
    }
    expect(waits).toEqual([5, 10, 30, 360, 360, 360]);
    expect(state.reads).toBe(6); // a genuinely incomplete list keeps being re-read, slowly, with no cap

    // The list grows: a pass that finds something waits the shortest time again.
    state.indexes = [0, 1, 7];
    clock.t = groupRecoverySchedule(id)!.nextAt;
    expect(await tick()).toMatchObject({ result: "RECOVERED" });
    expect((groupRecoverySchedule(id)!.nextAt - clock.t) / MIN).toBe(2);
  });

  it("a failing or still-loading read waits longer and leaves the database exactly as it was", async () => {
    const id = await newAccount();
    const tag = randomUUID().slice(0, 6);
    await seedGroups(id, tag, [{ i: 0, active: false }]);
    const provider = new MockProvider();
    let calls = 0;
    provider.getGroups = async () => {
      calls += 1;
      throw calls === 1 ? new GroupListNotReadyError("WhatsApp is still loading") : new Error("page crashed");
    };
    registry.registerForTesting(id, provider);

    await pastGrace(id);
    expect(await tick()).toMatchObject({ result: "ERROR" });
    expect((groupRecoverySchedule(id)!.nextAt - clock.t) / MIN).toBe(5);
    clock.t = groupRecoverySchedule(id)!.nextAt;
    expect(await tick()).toMatchObject({ result: "ERROR" });
    expect((groupRecoverySchedule(id)!.nextAt - clock.t) / MIN).toBe(10);
    expect(await activeOf(id, tag, 0)).toBe(false);
  });

  it("reads nothing while the machine is busy, even when a read is due", async () => {
    const id = await newAccount();
    const tag = randomUUID().slice(0, 6);
    await seedGroups(id, tag, [{ i: 0, active: false }]);
    const { provider, state } = listing(tag, [0]);
    registry.registerForTesting(id, provider);

    await pastGrace(id);
    const busy = await checkGroupRecovery(registry, { now: () => clock.t, load: () => ({ loadPerCpu: 99, eventLoopDelayMs: 0 }) });
    expect(busy).toEqual({ ran: false, reason: "OVERLOADED" });
    expect(state.reads).toBe(0);
    expect(await tick()).toMatchObject({ result: "RECOVERED" }); // and reads once it is calm again
  });
});

describe("load protection is bounded", () => {
  it("defers a due read while the machine is busy, but only for a bounded number of ticks", async () => {
    const id = await newAccount();
    const tag = randomUUID().slice(0, 6);
    await seedGroups(id, tag, [{ i: 0, active: false }]);
    const { provider, state } = listing(tag, [0]);
    registry.registerForTesting(id, provider);
    await pastGrace(id);

    const busy = () => checkGroupRecovery(registry, { now: () => clock.t, load: () => ({ loadPerCpu: 99, eventLoopDelayMs: 0 }) });
    for (let n = 0; n < GROUP_RECOVERY_SETTINGS.maxDeferredTicks; n += 1) {
      expect(await busy()).toEqual({ ran: false, reason: "OVERLOADED" });
    }
    expect(state.reads).toBe(0);
    // Deferred long enough: the next due read goes ahead even though the machine is still busy.
    expect(await busy()).toMatchObject({ ran: true, result: "RECOVERED" });
    expect(state.reads).toBe(1);
  });

  it("a calm tick resets the count of deferrals", async () => {
    const id = await newAccount();
    const tag = randomUUID().slice(0, 6);
    await seedGroups(id, tag, [{ i: 0, active: false }]);
    registry.registerForTesting(id, listing(tag, [0]).provider);
    await pastGrace(id);
    const busy = () => checkGroupRecovery(registry, { now: () => clock.t, load: () => ({ loadPerCpu: 99, eventLoopDelayMs: 0 }) });
    for (let n = 0; n < GROUP_RECOVERY_SETTINGS.maxDeferredTicks - 1; n += 1) await busy();
    clock.t -= backoffAfter(0); // nothing due on the calm tick below
    await tick(); // calm
    for (let n = 0; n < GROUP_RECOVERY_SETTINGS.maxDeferredTicks; n += 1) {
      expect(await busy()).toEqual({ ran: false, reason: "OVERLOADED" }); // the full allowance again
    }
  });
});

describe("the browser's own CPU", () => {
  const saved = GROUP_RECOVERY_SETTINGS.maxBrowserLoadPerCpu;
  afterEach(() => {
    GROUP_RECOVERY_SETTINGS.maxBrowserLoadPerCpu = saved;
  });
  const hot = { cpuPercent: 100_000, memoryBytes: 2 * 1_048_576 * 1024, processes: 9 }; // far above any host

  it("is measured and logged with every pass, but changes nothing while no threshold is set", async () => {
    const id = await newAccount();
    const tag = randomUUID().slice(0, 6);
    await seedGroups(id, tag, [{ i: 0, active: false }]);
    const { provider } = listing(tag, [0]);
    provider.browserUsage = hot;
    registry.registerForTesting(id, provider);

    expect(GROUP_RECOVERY_SETTINGS.maxBrowserLoadPerCpu).toBe(0);
    await pastGrace(id);
    expect(await tick()).toMatchObject({ result: "RECOVERED" }); // read despite the huge figure: no threshold chosen
    const log = await prisma.systemLog.findFirstOrThrow({ where: { message: "GROUP_RECOVERY_PASS" }, orderBy: { createdAt: "desc" } });
    expect((log.metadata as { browser: unknown }).browser).toEqual({ cpuPercent: 100_000, memoryMb: 2048, processes: 9 });
  });

  it("with a threshold set, defers a due read while the browser is busy — a bounded number of ticks — then goes ahead", async () => {
    GROUP_RECOVERY_SETTINGS.maxBrowserLoadPerCpu = 0.5;
    const id = await newAccount();
    const tag = randomUUID().slice(0, 6);
    await seedGroups(id, tag, [{ i: 0, active: false }]);
    const { provider, state } = listing(tag, [0]);
    provider.browserUsage = hot;
    registry.registerForTesting(id, provider);
    await pastGrace(id);

    for (let n = 0; n < GROUP_RECOVERY_SETTINGS.maxDeferredTicks; n += 1) {
      expect(await tick()).toEqual({ ran: false, reason: "OVERLOADED" });
    }
    expect(state.reads).toBe(0);
    expect(await tick()).toMatchObject({ ran: true, result: "RECOVERED" });
    expect(state.reads).toBe(1);
  });

  it("a calm browser reading does not defer, and unknown or failing readings count as not busy", async () => {
    GROUP_RECOVERY_SETTINGS.maxBrowserLoadPerCpu = 0.5;
    for (const usage of [{ cpuPercent: 1, memoryBytes: 1, processes: 1 }, null, "throw" as const]) {
      resetGroupRecoveryState();
      clock.t = 10_000_000;
      const id = await newAccount();
      const tag = randomUUID().slice(0, 6);
      await seedGroups(id, tag, [{ i: 0, active: false }]);
      const { provider } = listing(tag, [0]);
      provider.browserUsage = usage;
      registry = new ProviderRegistry();
      registry.registerForTesting(id, provider);
      await pastGrace(id);
      expect(await tick()).toMatchObject({ result: "RECOVERED" });
      expect(await activeOf(id, tag, 0)).toBe(true);
    }
  });
});

describe("the schedule follows the connection, not the process", () => {
  it("a worker restart forgets the schedule, not the need: a FAILED account is found again and recovered", async () => {
    const id = await newAccount({ sync: "FAILED" });
    const tag = randomUUID().slice(0, 6);
    await seedGroups(id, tag, [{ i: 0, active: false }]);
    const { provider } = listing(tag, [0]);
    registry.registerForTesting(id, provider);

    await tick(); // before the "restart"
    resetGroupRecoveryState(); // the process restarts: memory gone
    expect(groupRecoverySchedule(id)).toBeNull();
    expect((await accountRow(id)).groupSyncStatus).toBe("FAILED");

    await pastGrace(id); // found again from the database alone
    expect(await tick()).toMatchObject({ result: "RECOVERED" });
    expect(await activeOf(id, tag, 0)).toBe(true);
  });

  it("a reconnect starts a fresh schedule instead of inheriting the old one", async () => {
    const id = await newAccount({ sync: "PARTIAL" });
    const tag = randomUUID().slice(0, 6);
    await seedGroups(id, tag, [{ i: 0, active: true }, { i: 1, active: true }]);
    registry.registerForTesting(id, listing(tag, [0]).provider);

    await pastGrace(id);
    await tick(); // one read: no change, the wait is now 5 minutes
    const before = groupRecoverySchedule(id)!;
    expect(before.step).toBe(2);

    await prisma.whatsAppAccount.update({ where: { id }, data: { lastConnectedAt: new Date(1_000_000) } }); // the session came back
    clock.t = before.nextAt;
    await tick();
    expect(groupRecoverySchedule(id)).toMatchObject({ step: 1, nextAt: clock.t + backoffAfter(0) });
  });

  it("leaves a freshly connected account to the arrival watcher, then picks it up", async () => {
    const id = await newAccount({ sync: "PARTIAL", connectedAt: new Date(clock.t - 5 * MIN) });
    const tag = randomUUID().slice(0, 6);
    await seedGroups(id, tag, [{ i: 0, active: false }]);
    const { provider, state } = listing(tag, [0]);
    registry.registerForTesting(id, provider);

    await tick();
    clock.t += 5 * MIN;
    await tick();
    expect(state.reads).toBe(0);
    expect(groupRecoverySchedule(id)).toBeNull();

    clock.t += GROUP_RECOVERY_SETTINGS.afterConnectQuietMs; // the watcher's window is over
    await pastGrace(id);
    expect(await tick()).toMatchObject({ result: "RECOVERED" });
  });

  it("repeated reconnects keep recovery out of the arrival watcher's way, then a stable connection gets exactly one read", async () => {
    const id = await newAccount({ sync: "PARTIAL", connectedAt: new Date(clock.t - 1 * MIN) });
    const tag = randomUUID().slice(0, 6);
    await seedGroups(id, tag, [{ i: 0, active: true }, { i: 1, active: true }, { i: 2, active: false }]);
    const { provider, state } = listing(tag, [0, 2]); // 1 is an ACTIVE group the list lacks: genuinely partial
    registry.registerForTesting(id, provider);

    // The session drops and comes back every 12 minutes — shorter than the quiet window each time,
    // so every connect restarts it. Recovery never competes with the watcher that each connect starts.
    for (let flap = 0; flap < 5; flap += 1) {
      await tick();
      expect(groupRecoverySchedule(id)).toBeNull();
      clock.t += 12 * MIN;
      await prisma.whatsAppAccount.update({ where: { id }, data: { lastConnectedAt: new Date(clock.t - 1 * MIN) } });
    }
    expect(state.reads).toBe(0);

    // Then the connection holds. Nothing more reconnects; once the window since the LAST connect has
    // passed, recovery sees it, waits its short first delay, and reads — once.
    clock.t += GROUP_RECOVERY_SETTINGS.afterConnectQuietMs;
    await tick(); // first sighting of this connection
    expect(groupRecoverySchedule(id)).not.toBeNull();
    expect(state.reads).toBe(0);
    clock.t += backoffAfter(0);
    expect(await tick()).toMatchObject({ result: "RECOVERED" }); // reactivates 2
    expect(state.reads).toBe(1);
    expect(await activeOf(id, tag, 2)).toBe(true);
    expect(await tick()).toMatchObject({ ran: false }); // nothing is due again for a while
    expect(state.reads).toBe(1);
  });

  it("forgets the schedule of an account that no longer exists", async () => {
    const id = await newAccount({ sync: "PARTIAL" });
    const tag = randomUUID().slice(0, 6);
    await seedGroups(id, tag, [{ i: 0, active: false }]);
    registry.registerForTesting(id, listing(tag, [0]).provider);
    await tick();
    expect(groupRecoverySchedule(id)).not.toBeNull();

    await prisma.whatsAppGroup.deleteMany({ where: { accountId: id } });
    await prisma.whatsAppAccount.delete({ where: { id } });
    await tick();
    expect(groupRecoverySchedule(id)).toBeNull();
  });
});

describe("accounts that must not be touched", () => {
  const cases: Array<[string, () => Promise<{ id: string; provider: MockProvider }>]> = [
    ["a logged-out account (no phone number: its groups are inactive on purpose)", async () => ({ id: await newAccount({ phoneNumber: null }), provider: new MockProvider() })],
    ["an account the database says is not CONNECTED", async () => ({ id: await newAccount({ status: "DISCONNECTED" }), provider: new MockProvider() })],
    [
      "an account whose live session is not CONNECTED",
      async () => {
        const provider = new MockProvider();
        provider.connectionStatus = "DISCONNECTED";
        return { id: await newAccount(), provider };
      },
    ],
    ["a COMPLETED account with no inactive group", async () => ({ id: await newAccount({ sync: "COMPLETED" }), provider: new MockProvider() })],
  ];

  for (const [name, make] of cases) {
    it(`reads nothing for ${name}`, async () => {
      const { id, provider } = await make();
      const tag = randomUUID().slice(0, 6);
      const isCompleted = name.startsWith("a COMPLETED");
      await seedGroups(id, tag, [{ i: 0, active: isCompleted }]);
      let reads = 0;
      provider.getGroups = async () => {
        reads += 1;
        return [{ whatsappGroupId: gid(tag, 0), name: "G" }];
      };
      registry.registerForTesting(id, provider);

      await tick();
      clock.t += 24 * 60 * MIN;
      await tick();
      await tick();

      expect(reads).toBe(0);
      expect(await activeOf(id, tag, 0)).toBe(isCompleted);
    });
  }
});
