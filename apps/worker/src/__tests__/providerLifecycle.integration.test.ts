import "./helpers/requireTestDatabase.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { prisma } from "./helpers/projectFixtures.js";
import { ProviderRegistry } from "../provider/ProviderRegistry.js";
import { releaseDeletedAccounts } from "../provider/accountRegistrySync.js";
import type { WhatsAppProvider } from "../provider/WhatsAppProvider.js";

/**
 * A deleted account must take its browser with it.
 *
 * The registry only ever grew. `accountRegistrySync` connects an account it does not already hold
 * and never removes one, and there was no single-account teardown at all — only `disconnectAll`,
 * which runs at shutdown. So deleting an account in the dashboard cascaded its rows away and left
 * the worker holding a live `OpenWAProvider` and a 300-500MB Chromium for the rest of the process
 * lifetime, still listed by `allAccountIds()` — the list `pickSendingAccount` chooses from when it
 * needs a number to raise a collection alert through.
 *
 * It has to be reconciliation rather than a WorkerCommand: `WorkerCommand.accountId` is
 * `onDelete: Cascade`, so a command announcing the deletion would be deleted along with it.
 */

const registries: ProviderRegistry[] = [];
const createdAccountIds: string[] = [];

function stubProvider(): WhatsAppProvider & { disconnectCalls: number } {
  const provider = {
    disconnectCalls: 0,
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async function (this: { disconnectCalls: number }) {
      provider.disconnectCalls += 1;
    }),
    getConnectionStatus: () => "CONNECTED" as const,
    getGroups: async () => [],
    subscribeToMessages: () => undefined,
    fetchMessagesSince: async () => [],
    probeCollection: async () => ({ ok: true as const, messages: [] }),
    sendMessage: async () => ({ success: true }),
    getAccountInfo: async () => ({ phoneNumber: null, pushName: null }),
    verifyGroupMembership: async () => true,
    getGroupParticipantCount: async () => 0,
    getGroupParticipants: async () => [],
    addGroupParticipant: async () => ({ success: true }),
    logout: async () => undefined,
  } as unknown as WhatsAppProvider & { disconnectCalls: number };
  return provider;
}

function newRegistry() {
  const registry = new ProviderRegistry();
  registries.push(registry);
  return registry;
}

async function makeAccount() {
  const account = await prisma.whatsAppAccount.create({
    data: { label: `Lifecycle ${randomUUID()}`, status: "CONNECTED" },
  });
  createdAccountIds.push(account.id);
  return account;
}

afterEach(async () => {
  if (createdAccountIds.length) {
    await prisma.whatsAppAccount.deleteMany({ where: { id: { in: createdAccountIds } } });
    createdAccountIds.length = 0;
  }
  registries.length = 0;
});

describe("disconnectAccount", () => {
  it("removes the entry AND tears down the provider — not one without the other", async () => {
    // The failure worth pinning: dropping the Map entry alone leaves the browser running with
    // nothing left holding a reference to close it.
    const registry = newRegistry();
    const provider = stubProvider();
    registry.registerForTesting("acc-1", provider);

    expect(await registry.disconnectAccount("acc-1")).toBe(true);
    expect(registry.has("acc-1")).toBe(false);
    expect(registry.allAccountIds()).not.toContain("acc-1");
    expect(provider.disconnectCalls).toBe(1);
  });

  it("is idempotent — a second call is a no-op rather than an error", async () => {
    const registry = newRegistry();
    const provider = stubProvider();
    registry.registerForTesting("acc-2", provider);

    expect(await registry.disconnectAccount("acc-2")).toBe(true);
    expect(await registry.disconnectAccount("acc-2")).toBe(false);
    // Not torn down twice: the second call found nothing to tear down.
    expect(provider.disconnectCalls).toBe(1);
  });

  it("reports an unknown account rather than throwing", async () => {
    expect(await newRegistry().disconnectAccount("never-registered")).toBe(false);
  });

  it("still removes the entry when the browser refuses to close", async () => {
    // A browser that will not close is a leak to report, not a reason to leave the account
    // registered — and an unhandled rejection here would take the worker down.
    const registry = newRegistry();
    const provider = stubProvider();
    provider.disconnect = vi.fn(async () => {
      throw new Error("Chromium is not responding");
    });
    registry.registerForTesting("acc-3", provider);

    await expect(registry.disconnectAccount("acc-3")).resolves.toBe(true);
    expect(registry.has("acc-3")).toBe(false);
  });

  it("leaves every other account alone", async () => {
    const registry = newRegistry();
    registry.registerForTesting("keep-me", stubProvider());
    registry.registerForTesting("drop-me", stubProvider());

    await registry.disconnectAccount("drop-me");

    expect(registry.allAccountIds()).toEqual(["keep-me"]);
  });
});

describe("the registry reconciles against the database", () => {
  it("releases a provider whose account row no longer exists", async () => {
    // The whole bug, end to end.
    const account = await makeAccount();
    const registry = newRegistry();
    const provider = stubProvider();
    registry.registerForTesting(account.id, provider);

    await prisma.whatsAppAccount.delete({ where: { id: account.id } });
    createdAccountIds.length = 0;

    await releaseDeletedAccounts(registry);

    expect(registry.has(account.id)).toBe(false);
    expect(provider.disconnectCalls).toBe(1);
  });

  it("keeps a provider whose account is still there", async () => {
    // The other half — a sweep that releases a live account is far worse than one that leaks.
    const account = await makeAccount();
    const registry = newRegistry();
    const provider = stubProvider();
    registry.registerForTesting(account.id, provider);

    await releaseDeletedAccounts(registry);

    expect(registry.has(account.id)).toBe(true);
    expect(provider.disconnectCalls).toBe(0);
  });
});

describe("the reconciler is actually wired into the sync tick", () => {
  it("syncOnce releases deleted accounts before it connects anything", async () => {
    // Exporting the reconciler makes it testable; this is what proves the loop calls it, and that
    // it runs FIRST — releasing a dead entry is quick, while the connect below deliberately
    // returns after a single account and can wait minutes for a QR.
    const source = readFileSync(resolve(__dirname, "../provider/accountRegistrySync.ts"), "utf8");
    const body = source.slice(source.indexOf("async function syncOnce("));
    expect(body).toContain("await releaseDeletedAccounts(registry);");
    expect(body.indexOf("releaseDeletedAccounts")).toBeLessThan(body.indexOf("connectAccount"));
  });
});
