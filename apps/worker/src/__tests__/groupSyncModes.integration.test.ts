import "./helpers/requireTestDatabase.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma, inIsp } from "./helpers/projectFixtures.js";
import {
  cancelGroupSync,
  GROUP_ARRIVAL_SETTINGS,
  GroupListUnavailableError,
  GroupSyncCancelledError,
  hasPendingFullSync,
  resyncAndCatchUpAfterConnect,
  runGroupRecoveryPass,
  syncGroupsDetailed,
  syncGroupsWithTimeoutAndRetry,
} from "../commands/commandProcessor.js";
import { MockProvider } from "./mockProvider.js";

// Lets a test say "the worker has begun shutting down" without calling the real, process-global
// `beginShutdown()` (which would switch off every later trackTick in the file).
const shutdown = vi.hoisted(() => ({ value: false }));
vi.mock("../lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lifecycle.js")>()),
  isShuttingDown: () => shutdown.value,
}));

/**
 * What a manual FULL sync is promised, and what a group-list read is allowed to mean.
 *
 * (1) A FULL resync that arrives while an ADD_ONLY pass (arrival or recovery) is reading used to
 *     JOIN that pass and be handed its result — no stamp, no sweep, no status — so the operator
 *     believed a full sync had run. It is now queued behind the pass and run in its own right.
 * (2) Every read of the group list, in every mode, requires a live provider client before and after,
 *     and an empty list is not believed for an account that has groups on record.
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const accounts: string[] = [];
const SENTINEL = 777; // a recorded discovery a bad read must not overwrite
const gid = (tag: string, i: number) => `${tag}-${i}-1600000000@g.us`;

async function newAccount(sync: "COMPLETED" | "PARTIAL" | "FAILED" | null = "COMPLETED") {
  const a = await prisma.whatsAppAccount.create({
    data: { label: `Modes ${randomUUID()}`, status: "CONNECTED", groupSyncStatus: sync, groupSyncDiscovered: SENTINEL },
  });
  accounts.push(a.id);
  return a.id;
}

async function seed(accountId: string, tag: string, spec: Array<{ i: number; active: boolean }>) {
  await prisma.whatsAppGroup.createMany({
    data: spec.map(({ i, active }) => ({ accountId, whatsappGroupId: gid(tag, i), name: `G ${i}`, isActive: active })),
  });
}

const row = (accountId: string, tag: string, i: number) =>
  prisma.whatsAppGroup.findUniqueOrThrow({ where: { accountId_whatsappGroupId: { accountId, whatsappGroupId: gid(tag, i) } } });
const accountRow = (id: string) => prisma.whatsAppAccount.findUniqueOrThrow({ where: { id } });
const rowCount = (id: string) => prisma.whatsAppGroup.count({ where: { accountId: id } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A provider listing these indexes; reads can be held at a gate, and concurrent reads are counted. */
function gated(tag: string, indexes: number[]) {
  const provider = new MockProvider();
  let release!: () => void;
  const gateOpen = new Promise<void>((resolve) => (release = resolve));
  const s = { reads: 0, active: 0, maxActive: 0, hold: false, indexes };
  provider.getGroups = async () => {
    s.reads += 1;
    s.active += 1;
    s.maxActive = Math.max(s.maxActive, s.active);
    try {
      if (s.hold) await gateOpen;
      return s.indexes.map((i) => ({ whatsappGroupId: gid(tag, i), name: `G ${i}` }));
    } finally {
      s.active -= 1;
    }
  };
  return { provider, s, release };
}

beforeEach(() => {
  shutdown.value = false;
});

afterEach(async () => {
  shutdown.value = false;
  await prisma.systemLog.deleteMany({ where: { message: { in: ["GROUP_RECOVERY_PASS", "GROUP_ARRIVAL_SETTLED"] } } }).catch(() => undefined);
  await prisma.whatsAppGroup.deleteMany({ where: { accountId: { in: accounts } } });
  await prisma.whatsAppAccount.deleteMany({ where: { id: { in: accounts } } });
  accounts.length = 0;
});

describe("a manual FULL sync keeps its meaning when it arrives during an ADD_ONLY pass", () => {
  it("is queued, then run as a FULL sync of its own: second read, no overlap, the sweep and the stamp happen", async () => {
    const id = await newAccount("PARTIAL");
    const tag = randomUUID().slice(0, 6);
    await seed(id, tag, [{ i: 0, active: true }, { i: 1, active: true }, { i: 2, active: true }, { i: 3, active: true }]);
    const { provider, s, release } = gated(tag, [0, 1, 2]); // 3 has been left
    s.hold = true;

    const pass = runGroupRecoveryPass(id, provider, "RETRY");
    await sleep(50);
    const manual = syncGroupsWithTimeoutAndRetry(id, provider);
    await sleep(50);
    expect(hasPendingFullSync(id)).toBe(true);
    expect(s.reads).toBe(1); // queued, not reading beside the pass

    s.hold = false;
    release();
    expect(await pass).toMatchObject({ kind: "READ" });
    expect(await manual).toBe(3);

    expect(s.reads).toBe(2);
    expect(s.maxActive).toBe(1);
    expect(hasPendingFullSync(id)).toBe(false);
    // The FULL sync really ran: its sweep switched off the group that was left, and it stamped the rest.
    expect((await row(id, tag, 3)).isActive).toBe(false);
    expect((await row(id, tag, 0)).lastSyncedAt).not.toBeNull();
    expect(await accountRow(id)).toMatchObject({ groupSyncStatus: "COMPLETED", groupSyncDeactivated: 1 });
  });

  it("several FULL requests during one pass share ONE queued FULL sync", async () => {
    const id = await newAccount("PARTIAL");
    const tag = randomUUID().slice(0, 6);
    await seed(id, tag, [{ i: 0, active: true }, { i: 1, active: true }]);
    const { provider, s, release } = gated(tag, [0, 1]);
    s.hold = true;

    const pass = runGroupRecoveryPass(id, provider, "RETRY");
    await sleep(50);
    const requests = [syncGroupsWithTimeoutAndRetry(id, provider), syncGroupsWithTimeoutAndRetry(id, provider), syncGroupsWithTimeoutAndRetry(id, provider)];
    await sleep(50);
    s.hold = false;
    release();
    await pass;

    expect(await Promise.all(requests)).toEqual([2, 2, 2]);
    expect(s.reads).toBe(2); // the pass, plus ONE FULL for all three requests
    expect(s.maxActive).toBe(1);
  });

  it("two FULL requests with no pass in flight still join each other (unchanged)", async () => {
    const id = await newAccount("PARTIAL");
    const tag = randomUUID().slice(0, 6);
    await seed(id, tag, [{ i: 0, active: true }]);
    const { provider, s, release } = gated(tag, [0]);
    s.hold = true;

    const first = syncGroupsWithTimeoutAndRetry(id, provider);
    await sleep(50);
    const second = syncGroupsWithTimeoutAndRetry(id, provider);
    await sleep(50);
    expect(hasPendingFullSync(id)).toBe(false); // joined the running FULL, nothing queued
    s.hold = false;
    release();
    expect(await Promise.all([first, second])).toEqual([1, 1]);
    expect(s.reads).toBe(1);
  });

  it("a logout while it is queued drops it: it never runs, and nothing is changed by it", async () => {
    const id = await newAccount("PARTIAL");
    const tag = randomUUID().slice(0, 6);
    await seed(id, tag, [{ i: 0, active: true }, { i: 1, active: true }]);
    const { provider, s, release } = gated(tag, [0]); // 1 is missing: a FULL would sweep it
    s.hold = true;

    const pass = runGroupRecoveryPass(id, provider, "RETRY");
    await sleep(50);
    const manual = syncGroupsWithTimeoutAndRetry(id, provider);
    const outcome = manual.then(() => "resolved", (err: unknown) => (err instanceof GroupSyncCancelledError ? "cancelled" : "failed"));
    await sleep(50);
    expect(hasPendingFullSync(id)).toBe(true);

    const cancelling = cancelGroupSync(id, "the account was logged out");
    await sleep(50);
    expect(await outcome).toBe("cancelled");
    expect(hasPendingFullSync(id)).toBe(false);

    s.hold = false;
    release();
    await Promise.all([pass.catch(() => undefined), cancelling]); // the pass itself is cancelled too
    await sleep(100);
    expect(s.reads).toBe(1); // the queued FULL never read
    expect((await row(id, tag, 1)).isActive).toBe(true); // and never swept
  });

  it("a worker that has begun shutting down drops it instead of starting a read", async () => {
    const id = await newAccount("PARTIAL");
    const tag = randomUUID().slice(0, 6);
    await seed(id, tag, [{ i: 0, active: true }, { i: 1, active: true }]);
    const { provider, s, release } = gated(tag, [0]);
    s.hold = true;

    const pass = runGroupRecoveryPass(id, provider, "RETRY");
    await sleep(50);
    const manual = syncGroupsWithTimeoutAndRetry(id, provider);
    const outcome = manual.then(() => "resolved", (err: unknown) => (err instanceof GroupSyncCancelledError ? "cancelled" : "failed"));
    await sleep(50);

    shutdown.value = true;
    s.hold = false;
    release();
    await pass;
    expect(await outcome).toBe("cancelled");
    expect(s.reads).toBe(1);
    expect((await row(id, tag, 1)).isActive).toBe(true);
  });

  it("is scoped to its account: another account's FULL is not queued behind this one's pass, and neither touches the other", async () => {
    const a = await newAccount("PARTIAL");
    const b = await newAccount("PARTIAL");
    const tag = randomUUID().slice(0, 6);
    await seed(a, tag, [{ i: 0, active: true }, { i: 1, active: true }]);
    await seed(b, tag, [{ i: 0, active: true }, { i: 1, active: true }]); // the same WhatsApp ids
    const A = gated(tag, [0]); // a FULL on A sweeps 1
    const B = gated(tag, [0, 1]);
    B.s.hold = true;

    const bPass = runGroupRecoveryPass(b, B.provider, "RETRY");
    await sleep(50);
    const bFull = syncGroupsWithTimeoutAndRetry(b, B.provider); // queued behind B's pass
    await sleep(50);
    const aCount = await syncGroupsWithTimeoutAndRetry(a, A.provider); // runs at once, on its own account

    expect(aCount).toBe(1);
    expect(A.s.reads).toBe(1);
    expect(hasPendingFullSync(b)).toBe(true);
    expect(hasPendingFullSync(a)).toBe(false);
    expect((await row(a, tag, 1)).isActive).toBe(false); // A's sweep
    expect((await row(b, tag, 1)).isActive).toBe(true); // B untouched so far

    B.s.hold = false;
    B.release();
    await bPass;
    expect(await bFull).toBe(2);
    expect((await row(b, tag, 1)).isActive).toBe(true); // B lists 1: nothing to sweep
    expect(A.s.reads).toBe(1);
  });
});

describe("a group-list read that did not really happen is not a result, on every path", () => {
  it("manual FULL on a session with no live client: FAILED with the reason, no retry wait, nothing changed", async () => {
    const id = await newAccount("COMPLETED");
    const tag = randomUUID().slice(0, 6);
    await seed(id, tag, [{ i: 0, active: true }, { i: 1, active: false }]);
    const { provider, s } = gated(tag, [0, 1]);
    provider.liveClient = false;

    const started = Date.now();
    await expect(syncGroupsWithTimeoutAndRetry(id, provider)).rejects.toBeInstanceOf(GroupListUnavailableError);
    expect(Date.now() - started).toBeLessThan(5_000); // not three attempts with 10s and 30s waits

    expect(s.reads).toBe(0);
    expect((await row(id, tag, 1)).isActive).toBe(false);
    const a = await accountRow(id);
    expect(a.groupSyncStatus).toBe("FAILED");
    expect(a.groupSyncDiscovered).toBe(SENTINEL);
    expect(a.groupSyncError).toMatch(/no live browser/);
  });

  it("manual FULL: the session drops while the list is being read — the list is discarded", async () => {
    const id = await newAccount("COMPLETED");
    const tag = randomUUID().slice(0, 6);
    await seed(id, tag, [{ i: 0, active: true }, { i: 1, active: false }, { i: 2, active: true }]);
    const { provider, s, release } = gated(tag, [0, 1, 9]); // a dying page's list: names a known inactive group and a new one, lacks 2
    s.hold = true;

    const sync = syncGroupsWithTimeoutAndRetry(id, provider);
    const outcome = sync.then(() => "resolved", (err: unknown) => (err instanceof GroupListUnavailableError ? "unavailable" : "other"));
    await sleep(50);
    provider.liveClient = false;
    s.hold = false;
    release();

    expect(await outcome).toBe("unavailable");
    expect(await rowCount(id)).toBe(3); // 9 not created
    expect((await row(id, tag, 1)).isActive).toBe(false); // not switched on
    expect((await row(id, tag, 2)).isActive).toBe(true); // not swept
    expect(await accountRow(id)).toMatchObject({ groupSyncStatus: "FAILED", groupSyncDiscovered: SENTINEL });
  });

  it("manual FULL: an empty list for an account that HAS groups is not trusted; for one with none it is a real answer", async () => {
    const tag = randomUUID().slice(0, 6);
    const known = await newAccount("COMPLETED");
    await seed(known, tag, [{ i: 0, active: true }, { i: 1, active: false }]);
    await expect(syncGroupsWithTimeoutAndRetry(known, gated(tag, []).provider)).rejects.toMatchObject({ name: "GroupListUnavailableError", reason: "EMPTY_LIST" });
    expect(await accountRow(known)).toMatchObject({ groupSyncStatus: "FAILED", groupSyncDiscovered: SENTINEL });
    expect((await row(known, tag, 0)).isActive).toBe(true); // an empty list never sweeps
    expect(await rowCount(known)).toBe(2);

    const none = await newAccount("FAILED");
    expect(await syncGroupsWithTimeoutAndRetry(none, gated(tag, []).provider)).toBe(0);
    expect(await accountRow(none)).toMatchObject({ groupSyncStatus: "COMPLETED", groupSyncDiscovered: 0 });
  });

  it("the sweep guard still holds a FULL sync that lists far fewer groups than are active", async () => {
    const id = await newAccount("COMPLETED");
    const tag = randomUUID().slice(0, 6);
    await seed(id, tag, Array.from({ length: 60 }, (_, i) => ({ i, active: true })));
    const { provider } = gated(tag, Array.from({ length: 30 }, (_, i) => i)); // half of them
    await syncGroupsWithTimeoutAndRetry(id, provider);
    expect(await prisma.whatsAppGroup.count({ where: { accountId: id, isActive: true } })).toBe(60);
    expect(await accountRow(id)).toMatchObject({ groupSyncStatus: "PARTIAL" });
  });

  it("an arrival (ADD_ONLY) pass on a session with no live client writes nothing", async () => {
    const id = await newAccount("PARTIAL");
    const tag = randomUUID().slice(0, 6);
    await seed(id, tag, [{ i: 0, active: false }]);
    const { provider, s } = gated(tag, [0, 1]);
    provider.liveClient = false;

    await expect(syncGroupsDetailed(id, provider, "ADD_ONLY", undefined, GROUP_ARRIVAL_SETTINGS.readTimeoutMs)).rejects.toBeInstanceOf(GroupListUnavailableError);
    expect(s.reads).toBe(0);
    expect((await row(id, tag, 0)).isActive).toBe(false);
    expect(await rowCount(id)).toBe(1);
  });

  it("an arrival pass that loses the session mid-read discards the list", async () => {
    const id = await newAccount("PARTIAL");
    const tag = randomUUID().slice(0, 6);
    await seed(id, tag, [{ i: 0, active: false }]);
    const { provider, s, release } = gated(tag, [0, 1]);
    s.hold = true;

    const pass = syncGroupsDetailed(id, provider, "ADD_ONLY", undefined, GROUP_ARRIVAL_SETTINGS.readTimeoutMs);
    const outcome = pass.then(() => "resolved", (err: unknown) => (err instanceof GroupListUnavailableError ? "unavailable" : "other"));
    await sleep(50);
    provider.liveClient = false;
    s.hold = false;
    release();

    expect(await outcome).toBe("unavailable");
    expect((await row(id, tag, 0)).isActive).toBe(false);
    expect(await rowCount(id)).toBe(1);
  });

  it("empty reads in the middle of the arrival do not count as a settled list", async () => {
    const saved = { ...GROUP_ARRIVAL_SETTINGS };
    GROUP_ARRIVAL_SETTINGS.intervalMs = 30;
    try {
      const id = await newAccount(null);
      const tag = randomUUID().slice(0, 6);
      const provider = new MockProvider();
      const counts = [5, 0, 0, 0, 5, 5, 5, 5]; // the connect's read, three empty reads, then the list stays at 5
      let reads = 0;
      provider.getGroups = async () => {
        const n = counts[Math.min(reads, counts.length - 1)]!;
        reads += 1;
        return Array.from({ length: n }, (_, i) => ({ whatsappGroupId: gid(tag, i), name: `G ${i}` }));
      };

      await inIsp(async () => resyncAndCatchUpAfterConnect(id, provider, "test"));
      const settled = async () =>
        prisma.systemLog.findFirst({ where: { message: "GROUP_ARRIVAL_SETTLED", metadata: { path: ["accountId"], equals: id } } });
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && !(await settled())) await sleep(25);

      const meta = (await settled())!.metadata as { passes: number; outcome: string };
      // Three empty reads are unknown (they used to count as "stable" and settle after three passes);
      // only the three reads of 5 that follow are.
      expect(meta).toMatchObject({ passes: 6, outcome: "SETTLED" });
      expect(await prisma.whatsAppGroup.count({ where: { accountId: id, isActive: true } })).toBe(5);
    } finally {
      Object.assign(GROUP_ARRIVAL_SETTINGS, saved);
    }
  });
});
