import "./helpers/requireTestDatabase.js";
import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma, inIsp } from "./helpers/projectFixtures.js";
import {
  cancelGroupSync,
  GroupSyncCancelledError,
  GROUP_ARRIVAL_SETTINGS,
  groupArrivalDecision,
  resyncAndCatchUpAfterConnect,
  startCommandProcessor,
  syncGroups,
  syncGroupsDetailed,
  syncGroupsWithTimeoutAndRetry,
} from "../commands/commandProcessor.js";
import { reconcileAccountStatusesOnBoot } from "../recovery.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ProviderRegistry } from "../provider/ProviderRegistry.js";
import { MockProvider } from "./mockProvider.js";

/**
 * The group sync at roster scale (GROUP_SYNC.md): 2,000 groups per account, two accounts, reruns,
 * a group that cannot be saved, a phone still sending its chats, and a resync of one account that
 * must not wait behind another's.
 */

const accounts: string[] = [];
const roster = (tag: string, n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => ({ whatsappGroupId: `${tag}-${from + i}-1600000000@g.us`, name: `Group ${tag} ${from + i}` }));

async function newAccount(status: "CONNECTED" | "DISCONNECTED" = "CONNECTED") {
  const a = await prisma.whatsAppAccount.create({ data: { label: `Sync ${randomUUID()}`, status } });
  accounts.push(a.id);
  return a.id;
}

const waitFor = async (check: () => Promise<boolean>, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

afterEach(async () => {
  await prisma.workerCommand.deleteMany({ where: { accountId: { in: accounts } } });
  await prisma.whatsAppGroup.deleteMany({ where: { accountId: { in: accounts } } });
  await prisma.whatsAppAccount.deleteMany({ where: { id: { in: accounts } } });
  accounts.length = 0;
});

describe("2,000 groups per account", () => {
  it("a new account gets every group in one read and bounded batches, and its state says so", async () => {
    const id = await newAccount();
    const provider = new MockProvider();
    let reads = 0;
    provider.getGroups = async () => {
      reads += 1;
      return roster(randomUUID().slice(0, 6), 2000);
    };

    expect(await syncGroupsWithTimeoutAndRetry(id, provider)).toBe(2000);
    expect(reads).toBe(1);
    expect(await prisma.whatsAppGroup.count({ where: { accountId: id, isActive: true } })).toBe(2000);
    const account = await prisma.whatsAppAccount.findUniqueOrThrow({ where: { id } });
    expect(account).toMatchObject({ groupSyncStatus: "COMPLETED", groupSyncDiscovered: 2000, groupSyncNew: 2000, groupSyncFailed: 0, groupSyncStage: null });
    expect(account.groupSyncDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("running it again creates nothing, changes nothing, and keeps every setting a person made", async () => {
    const id = await newAccount();
    const groups = roster(randomUUID().slice(0, 6), 2000);
    const provider = new MockProvider();
    provider.getGroups = async () => groups;
    await syncGroups(id, provider);

    const member = await prisma.internalTeamMember.create({ data: { name: `Owner ${randomUUID()}`, phoneNumber: `+8801${Math.floor(Math.random() * 1e9)}`, role: "Support" } });
    const configured = await prisma.whatsAppGroup.findFirstOrThrow({ where: { accountId: id, whatsappGroupId: groups[7]!.whatsappGroupId } });
    await prisma.whatsAppGroup.update({
      where: { id: configured.id },
      data: { isMonitored: true, aiAutomationEnabled: true, aiAutomationExcluded: true, priority: "P1", testModeEnabled: true, escalationMonitoringEnabled: true, assignedTeamMemberId: member.id, chatCategoryId: null },
    });

    // Renamed on WhatsApp in between: the name follows WhatsApp, the settings stay.
    groups[7] = { ...groups[7]!, name: "Renamed on WhatsApp" };
    const outcome = await syncGroupsDetailed(id, provider);
    expect(outcome).toMatchObject({ discovered: 2000, created: 0, renamed: 1, reactivated: 0, deactivated: 0, failed: 0 });
    expect(await prisma.whatsAppGroup.count({ where: { accountId: id } })).toBe(2000);
    expect(await prisma.whatsAppGroup.findUniqueOrThrow({ where: { id: configured.id } })).toMatchObject({
      name: "Renamed on WhatsApp",
      isMonitored: true,
      aiAutomationEnabled: true,
      aiAutomationExcluded: true,
      priority: "P1",
      testModeEnabled: true,
      escalationMonitoringEnabled: true,
      assignedTeamMemberId: member.id,
    });
    await prisma.whatsAppGroup.update({ where: { id: configured.id }, data: { assignedTeamMemberId: null } });
    await prisma.internalTeamMember.delete({ where: { id: member.id } });
  });

  it("a group is account + WhatsApp id: the same group and the same name on two accounts are two rows, and one account's sync never touches the other's", async () => {
    const a = await newAccount();
    const b = await newAccount();
    const shared = roster(randomUUID().slice(0, 6), 50);
    const providerA = new MockProvider();
    const providerB = new MockProvider();
    providerA.getGroups = async () => shared;
    providerB.getGroups = async () => shared;
    await syncGroups(a, providerA);
    await syncGroups(b, providerB);
    expect(await prisma.whatsAppGroup.count({ where: { whatsappGroupId: shared[0]!.whatsappGroupId } })).toBe(2);

    // A leaves a few groups; B is still in them and keeps them active.
    providerA.getGroups = async () => shared.slice(5);
    await syncGroups(a, providerA);
    expect(await prisma.whatsAppGroup.count({ where: { accountId: a, isActive: false } })).toBe(5);
    expect(await prisma.whatsAppGroup.count({ where: { accountId: b, isActive: false } })).toBe(0);
  });
});

describe("partial failure", () => {
  it("one group that cannot be saved costs only itself; the sync is PARTIAL and the next pass saves it", async () => {
    const id = await newAccount();
    const groups = roster(randomUUID().slice(0, 6), 1200);
    // Postgres refuses a NUL byte in text — a real way for one row of a batch to fail.
    groups[700] = { ...groups[700]!, name: "Broken\u0000name" };
    const provider = new MockProvider();
    provider.getGroups = async () => groups;

    await syncGroupsWithTimeoutAndRetry(id, provider);
    expect(await prisma.whatsAppGroup.count({ where: { accountId: id } })).toBe(1199);
    const account = await prisma.whatsAppAccount.findUniqueOrThrow({ where: { id } });
    expect(account).toMatchObject({ groupSyncStatus: "PARTIAL", groupSyncFailed: 1, groupSyncNew: 1199 });
    expect(account.groupSyncError).toMatch(/could not be saved/);

    groups[700] = { ...groups[700]!, name: "Fixed name" };
    await syncGroupsWithTimeoutAndRetry(id, provider);
    expect(await prisma.whatsAppGroup.count({ where: { accountId: id } })).toBe(1200);
    expect((await prisma.whatsAppAccount.findUniqueOrThrow({ where: { id } })).groupSyncStatus).toBe("COMPLETED");
  });

  it("a list far shorter than what is active switches nothing off, and is reported PARTIAL", async () => {
    const id = await newAccount();
    const groups = roster(randomUUID().slice(0, 6), 500);
    const provider = new MockProvider();
    provider.getGroups = async () => groups;
    await syncGroupsWithTimeoutAndRetry(id, provider);
    provider.getGroups = async () => groups.slice(0, 100);
    await syncGroupsWithTimeoutAndRetry(id, provider);
    expect(await prisma.whatsAppGroup.count({ where: { accountId: id, isActive: true } })).toBe(500);
    expect((await prisma.whatsAppAccount.findUniqueOrThrow({ where: { id } })).groupSyncStatus).toBe("PARTIAL");
  });

  it("a sync that cannot read the list ends FAILED with the reason", async () => {
    const id = await newAccount();
    const provider = new MockProvider();
    const { SessionNotReadyError } = await import("../provider/WhatsAppProvider.js");
    provider.getGroups = async () => {
      throw new SessionNotReadyError("This account was logged out on the phone.");
    };
    await expect(syncGroupsWithTimeoutAndRetry(id, provider)).rejects.toThrow();
    expect(await prisma.whatsAppAccount.findUniqueOrThrow({ where: { id } })).toMatchObject({ groupSyncStatus: "FAILED", groupSyncError: "This account was logged out on the phone." });
  });
});

describe("no duplicate syncs, and no account waits for another", () => {
  it("two requests for the same account share one read of the list", async () => {
    const id = await newAccount();
    const provider = new MockProvider();
    let reads = 0;
    provider.getGroups = async () => {
      reads += 1;
      await new Promise((r) => setTimeout(r, 200));
      return roster(randomUUID().slice(0, 6), 100);
    };
    await Promise.all([syncGroupsWithTimeoutAndRetry(id, provider), syncGroupsWithTimeoutAndRetry(id, provider)]);
    expect(reads).toBe(1);
  });

  it("a resync of account B is not held behind a slow resync of account A", async () => {
    const a = await newAccount();
    const b = await newAccount();
    const providerA = new MockProvider();
    const providerB = new MockProvider();
    let releaseA!: () => void;
    providerA.getGroups = () => new Promise((resolve) => (releaseA = () => resolve(roster(randomUUID().slice(0, 6), 10))));
    providerB.getGroups = async () => roster(randomUUID().slice(0, 6), 10);
    const registry = new ProviderRegistry();
    registry.registerForTesting(a, providerA);
    registry.registerForTesting(b, providerB);
    await prisma.workerCommand.create({ data: { type: "RESYNC_GROUPS", accountId: a } });
    await prisma.workerCommand.create({ data: { type: "RESYNC_GROUPS", accountId: b } });
    const interval = startCommandProcessor(registry, 10);
    try {
      // B finishes while A is still reading its list.
      expect(await waitFor(async () => (await prisma.whatsAppGroup.count({ where: { accountId: b } })) === 10)).toBe(true);
      expect(await waitFor(async () => (await prisma.workerCommand.findFirst({ where: { accountId: b } }))?.status === "DONE")).toBe(true);
      expect((await prisma.workerCommand.findFirst({ where: { accountId: a } }))?.status).toBe("PROCESSING");
      releaseA();
      expect(await waitFor(async () => (await prisma.workerCommand.findFirst({ where: { accountId: a } }))?.status === "DONE")).toBe(true);
    } finally {
      clearInterval(interval);
      releaseA?.();
    }
  });
});

describe("a newly linked phone still sending its chats", () => {
  it("decides when the list has settled", () => {
    const settings = { stableReads: 3, maxMs: 1000 };
    expect(groupArrivalDecision([400, 300, 0, 0], 100, settings)).toBe("CONTINUE");
    expect(groupArrivalDecision([400, 0, 0, 0], 100, settings)).toBe("SETTLED");
    expect(groupArrivalDecision([400, 300, 200], 1000, settings)).toBe("GAVE_UP");
  });

  it("groups appear as the phone delivers them, without waiting for a five-minute pass, and nothing is switched off while it fills in", async () => {
    const id = await newAccount();
    const tag = randomUUID().slice(0, 6);
    const provider = new MockProvider();
    // The page's chat list grows by 500 groups each read, up to 2,000.
    let delivered = 500;
    provider.getGroups = async () => {
      const list = roster(tag, delivered);
      delivered = Math.min(2000, delivered + 500);
      return list;
    };
    const saved = { ...GROUP_ARRIVAL_SETTINGS };
    GROUP_ARRIVAL_SETTINGS.intervalMs = 50;
    try {
      await inIsp(async () => resyncAndCatchUpAfterConnect(id, provider, "test"));
      const started = Date.now();
      expect(await waitFor(async () => (await prisma.whatsAppGroup.count({ where: { accountId: id } })) === 2000, 15_000)).toBe(true);
      const allVisibleAfterMs = Date.now() - started;
      expect(allVisibleAfterMs).toBeLessThan(15_000); // the old follow-up came at 5 minutes
      expect(await prisma.whatsAppGroup.count({ where: { accountId: id, isActive: false } })).toBe(0);
      // Settles, then one FULL sync records the finished list.
      expect(
        await waitFor(async () => {
          const account = await prisma.whatsAppAccount.findUniqueOrThrow({ where: { id } });
          return account.groupSyncStatus === "COMPLETED" && account.groupSyncDiscovered === 2000;
        }, 15_000),
      ).toBe(true);
    } finally {
      Object.assign(GROUP_ARRIVAL_SETTINGS, saved);
      provider.connectionStatus = "DISCONNECTED"; // stops any pass still scheduled
    }
  }, 40_000);
});

describe("the ADD_ONLY pass", () => {
  it("adds and reactivates, and never switches a group off or restamps the roster", async () => {
    const id = await newAccount();
    const groups = roster(randomUUID().slice(0, 6), 2000);
    const provider = new MockProvider();
    provider.getGroups = async () => groups;
    await syncGroups(id, provider);
    const stampBefore = (await prisma.whatsAppGroup.findFirstOrThrow({ where: { accountId: id } })).lastSyncedAt;

    // 50 groups missing from a still-arriving list (a FULL sync would switch these off), 10 new.
    provider.getGroups = async () => [...groups.slice(50), ...roster(randomUUID().slice(0, 6), 10)];
    const outcome = await syncGroupsDetailed(id, provider, "ADD_ONLY");
    expect(outcome).toMatchObject({ created: 10, deactivated: 0 });
    expect(await prisma.whatsAppGroup.count({ where: { accountId: id, isActive: false } })).toBe(0);
    expect((await prisma.whatsAppGroup.findFirstOrThrow({ where: { accountId: id, whatsappGroupId: groups[100]!.whatsappGroupId } })).lastSyncedAt).toEqual(stampBefore);
  });
});

describe("Logout and Reconnect stop a running sync", () => {
  it("Logout during a resync: the sync is CANCELLED, writes nothing afterwards, and does not switch the groups back on", async () => {
    const id = await newAccount();
    const tag = randomUUID().slice(0, 6);
    const provider = new MockProvider();
    provider.getGroups = async () => roster(tag, 50);
    await syncGroups(id, provider);

    // The next read hangs until released, as a slow WhatsApp page would.
    let release!: () => void;
    provider.getGroups = () => new Promise((resolve) => (release = () => resolve(roster(tag, 60))));
    const registry = new ProviderRegistry();
    registry.registerForTesting(id, provider);
    const resync = await prisma.workerCommand.create({ data: { type: "RESYNC_GROUPS", accountId: id } });
    const interval = startCommandProcessor(registry, 10);
    try {
      expect(await waitFor(async () => (await prisma.whatsAppAccount.findUniqueOrThrow({ where: { id } })).groupSyncStatus === "RUNNING")).toBe(true);
      const logout = await prisma.workerCommand.create({ data: { type: "LOGOUT", accountId: id } });
      expect(await waitFor(async () => (await prisma.workerCommand.findUniqueOrThrow({ where: { id: logout.id } })).status === "DONE")).toBe(true);

      const afterLogout = await prisma.whatsAppAccount.findUniqueOrThrow({ where: { id } });
      expect(afterLogout).toMatchObject({ groupSyncStatus: "CANCELLED", groupSyncError: "Stopped because the account was logged out." });
      expect(await prisma.whatsAppGroup.count({ where: { accountId: id, isActive: true } })).toBe(0);

      // The read finally returns — with ten new groups — after the logout.
      release();
      expect(await waitFor(async () => (await prisma.workerCommand.findUniqueOrThrow({ where: { id: resync.id } })).status === "DONE")).toBe(true);
      expect((await prisma.workerCommand.findUniqueOrThrow({ where: { id: resync.id } })).result).toMatchObject({ cancelled: true });
      expect(await prisma.whatsAppGroup.count({ where: { accountId: id } })).toBe(50);
      expect(await prisma.whatsAppGroup.count({ where: { accountId: id, isActive: true } })).toBe(0);
      expect((await prisma.whatsAppAccount.findUniqueOrThrow({ where: { id } })).groupSyncStatus).toBe("CANCELLED");
    } finally {
      clearInterval(interval);
      release?.();
    }
  });

  it("a sync cancelled for a reconnect never overwrites the newer sync that replaced it", async () => {
    const id = await newAccount();
    const tag = randomUUID().slice(0, 6);
    const oldProvider = new MockProvider();
    let release!: () => void;
    oldProvider.getGroups = () => new Promise((resolve) => (release = () => resolve(roster(`${tag}old`, 40))));
    const oldSync = syncGroupsWithTimeoutAndRetry(id, oldProvider);
    expect(await waitFor(async () => (await prisma.whatsAppAccount.findUniqueOrThrow({ where: { id } })).groupSyncStatus === "RUNNING")).toBe(true);

    expect(await inIsp(() => cancelGroupSync(id, "Stopped for a reconnect. A new sync starts once the account is connected again."))).toBe(true);
    expect((await prisma.whatsAppAccount.findUniqueOrThrow({ where: { id } })).groupSyncStatus).toBe("CANCELLED");

    // The reconnect's own sync is a new one, not a join of the cancelled one.
    const newProvider = new MockProvider();
    newProvider.getGroups = async () => roster(`${tag}new`, 25);
    expect(await syncGroupsWithTimeoutAndRetry(id, newProvider)).toBe(25);

    release();
    await expect(oldSync).rejects.toBeInstanceOf(GroupSyncCancelledError);
    expect(await prisma.whatsAppGroup.count({ where: { accountId: id } })).toBe(25);
    expect(await prisma.whatsAppAccount.findUniqueOrThrow({ where: { id } })).toMatchObject({ groupSyncStatus: "COMPLETED", groupSyncDiscovered: 25 });
  });

  it("cancelling with nothing running records nothing", async () => {
    const id = await newAccount();
    expect(await inIsp(() => cancelGroupSync(id, "x"))).toBe(false);
    expect((await prisma.whatsAppAccount.findUniqueOrThrow({ where: { id } })).groupSyncStatus).toBeNull();
  });

  it("both commands cancel before they tear the session down", () => {
    const source = readFileSync(resolve(__dirname, "../commands/commandProcessor.ts"), "utf8");
    const reconnect = source.slice(source.indexOf('case "RECONNECT"'), source.indexOf('case "LOGOUT"'));
    expect(reconnect.indexOf("cancelGroupSync(accountId")).toBeGreaterThan(-1);
    expect(reconnect.indexOf("cancelGroupSync(accountId")).toBeLessThan(reconnect.indexOf("await provider.disconnect()"));
    const logout = source.slice(source.indexOf('case "LOGOUT"'), source.indexOf('case "RESYNC_GROUPS"'));
    expect(logout.indexOf("cancelGroupSync(accountId")).toBeGreaterThan(-1);
    expect(logout.indexOf("cancelGroupSync(accountId")).toBeLessThan(logout.indexOf("await provider.logout()"));
  });
});

describe("a restart mid-sync", () => {
  it("does not leave an account saying 'syncing' forever", async () => {
    const id = await newAccount("DISCONNECTED");
    await prisma.whatsAppAccount.update({ where: { id }, data: { groupSyncStatus: "RUNNING", groupSyncStage: "Reading the group list from WhatsApp" } });
    await reconcileAccountStatusesOnBoot();
    expect(await prisma.whatsAppAccount.findUniqueOrThrow({ where: { id } })).toMatchObject({ groupSyncStatus: "FAILED", groupSyncStage: null });
  });
});
