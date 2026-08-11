import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@support-automation/db";
import type { WhatsAppAccount } from "@prisma/client";
import { processOneCommand, startCommandProcessor, syncGroupsWithTimeoutAndRetry } from "../commands/commandProcessor.js";
import { MockProvider } from "./mockProvider.js";

/**
 * ENGINEERING_STANDARDS.md §9 (Command Safety) -- regression coverage for
 * the exact incident class hit for real this session: a stale RECONNECT
 * command tearing down an already-healthy session, and the command loop's
 * setInterval letting a second command start while the first was still
 * mid-flight.
 */

let account: WhatsAppAccount;

function uniqueGroupJid(): string {
  return `${randomUUID().replace(/-/g, "").slice(0, 10)}-1234567890@g.us`;
}

beforeEach(async () => {
  account = await prisma.whatsAppAccount.create({
    data: { label: `Command Safety Test Account ${randomUUID()}`, status: "CONNECTED", phoneNumber: "+8801000000000" },
  });
});

afterEach(async () => {
  await prisma.whatsAppAccount.delete({ where: { id: account.id } });
});

describe("RECONNECT: skip when already healthily connected", () => {
  it("does not call disconnect()/connect() when the provider already reports CONNECTED", async () => {
    const provider = new MockProvider();
    let disconnectCalled = false;
    let connectCalled = false;
    provider.disconnect = async () => {
      disconnectCalled = true;
    };
    provider.connect = async () => {
      connectCalled = true;
    };

    const command = await prisma.workerCommand.create({ data: { type: "RECONNECT" } });
    await processOneCommand(account.id, provider);

    const refreshed = await prisma.workerCommand.findUniqueOrThrow({ where: { id: command.id } });
    expect(refreshed.status).toBe("DONE");
    expect(refreshed.result).toMatchObject({ reconnected: false });
    expect(disconnectCalled).toBe(false);
    expect(connectCalled).toBe(false);
  });

  it("still reconnects for real when the provider is not currently connected", async () => {
    const provider = new MockProvider();
    provider.getConnectionStatus = () => "DISCONNECTED";
    let connectCalled = false;
    provider.connect = async () => {
      connectCalled = true;
    };

    const command = await prisma.workerCommand.create({ data: { type: "RECONNECT" } });
    await processOneCommand(account.id, provider);

    const refreshed = await prisma.workerCommand.findUniqueOrThrow({ where: { id: command.id } });
    expect(refreshed.status).toBe("DONE");
    expect(refreshed.result).toMatchObject({ reconnected: true });
    expect(connectCalled).toBe(true);
  });
});

describe("Group sync: dedupe concurrent callers", () => {
  it("collapses two simultaneous syncGroupsWithTimeoutAndRetry calls into a single underlying sync", async () => {
    const provider = new MockProvider();
    let getGroupsCallCount = 0;
    provider.getGroups = async () => {
      getGroupsCallCount++;
      await new Promise((resolve) => setTimeout(resolve, 40));
      return [{ whatsappGroupId: uniqueGroupJid(), name: "Concurrent Sync Target" }];
    };

    const [countA, countB] = await Promise.all([
      syncGroupsWithTimeoutAndRetry(account.id, provider),
      syncGroupsWithTimeoutAndRetry(account.id, provider),
    ]);

    expect(getGroupsCallCount).toBe(1); // the second caller reused the first's in-flight sync, not a second one
    expect(countA).toBe(countB);
  });

  it("allows a genuinely later sync (after the first has finished) to run for real", async () => {
    const provider = new MockProvider();
    let getGroupsCallCount = 0;
    provider.getGroups = async () => {
      getGroupsCallCount++;
      return [];
    };

    await syncGroupsWithTimeoutAndRetry(account.id, provider);
    await syncGroupsWithTimeoutAndRetry(account.id, provider);

    expect(getGroupsCallCount).toBe(2); // sequential, not concurrent -- both should genuinely run
  });
});

describe("Command loop: never overlaps two commands", () => {
  it("does not claim a second pending command while the first is still mid-flight, even past the tick interval", async () => {
    const provider = new MockProvider();
    provider.getConnectionStatus = () => "DISCONNECTED"; // force RECONNECT to actually attempt connect(), not skip
    let releaseConnect: () => void = () => {};
    provider.connect = () => new Promise<void>((resolve) => (releaseConnect = resolve));

    const reconnectCommand = await prisma.workerCommand.create({ data: { type: "RECONNECT" } });
    const resyncCommand = await prisma.workerCommand.create({ data: { type: "RESYNC_GROUPS" } });

    const interval = startCommandProcessor(account.id, provider, 10);
    try {
      await new Promise((resolve) => setTimeout(resolve, 60)); // several tick intervals while RECONNECT is stuck

      const reconnectMidFlight = await prisma.workerCommand.findUniqueOrThrow({ where: { id: reconnectCommand.id } });
      const resyncMidFlight = await prisma.workerCommand.findUniqueOrThrow({ where: { id: resyncCommand.id } });
      expect(reconnectMidFlight.status).toBe("PROCESSING");
      expect(resyncMidFlight.status).toBe("PENDING"); // never claimed while RECONNECT was still running

      releaseConnect();
      await new Promise((resolve) => setTimeout(resolve, 60)); // let RECONNECT finish and RESYNC_GROUPS get its turn

      const reconnectFinal = await prisma.workerCommand.findUniqueOrThrow({ where: { id: reconnectCommand.id } });
      const resyncFinal = await prisma.workerCommand.findUniqueOrThrow({ where: { id: resyncCommand.id } });
      expect(reconnectFinal.status).toBe("DONE");
      expect(resyncFinal.status).toBe("DONE");
    } finally {
      clearInterval(interval);
    }
  });
});

describe("LOGOUT", () => {
  it("calls provider.logout(), clears the account's phone number, and marks the command DONE", async () => {
    const provider = new MockProvider();

    const command = await prisma.workerCommand.create({ data: { type: "LOGOUT" } });
    await processOneCommand(account.id, provider);

    expect(provider.loggedOut).toBe(true);

    const refreshedAccount = await prisma.whatsAppAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(refreshedAccount.phoneNumber).toBeNull();

    const refreshedCommand = await prisma.workerCommand.findUniqueOrThrow({ where: { id: command.id } });
    expect(refreshedCommand.status).toBe("DONE");
    expect(refreshedCommand.result).toMatchObject({ loggedOut: true });
  });

  it("never touches a different account's phone number", async () => {
    const otherAccount = await prisma.whatsAppAccount.create({
      data: { label: `Other Account ${randomUUID()}`, status: "CONNECTED", phoneNumber: "+8801999999999" },
    });
    try {
      const provider = new MockProvider();
      await prisma.workerCommand.create({ data: { type: "LOGOUT" } });
      await processOneCommand(account.id, provider); // logs out `account`, not `otherAccount`

      const refreshedOther = await prisma.whatsAppAccount.findUniqueOrThrow({ where: { id: otherAccount.id } });
      expect(refreshedOther.phoneNumber).toBe("+8801999999999");
    } finally {
      await prisma.whatsAppAccount.delete({ where: { id: otherAccount.id } });
    }
  });

  it("still completes even if the underlying provider.logout() rejects", async () => {
    const provider = new MockProvider();
    provider.logout = async () => {
      throw new Error("simulated logout failure");
    };

    const command = await prisma.workerCommand.create({ data: { type: "LOGOUT" } });
    await processOneCommand(account.id, provider);

    // The interface contract says logout() never throws; if a provider implementation breaks that
    // contract anyway, the existing generic catch-all still reports it as FAILED rather than
    // silently losing the command -- consistent with every other command type.
    const refreshedCommand = await prisma.workerCommand.findUniqueOrThrow({ where: { id: command.id } });
    expect(refreshedCommand.status).toBe("FAILED");
  });
});
