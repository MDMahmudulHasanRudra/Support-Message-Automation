import "./helpers/requireTestDatabase.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@support-automation/db";
import type { WhatsAppAccount } from "@prisma/client";
import { processOneCommand, startCommandProcessor, syncGroupsWithTimeoutAndRetry } from "../commands/commandProcessor.js";
import { ProviderRegistry } from "../provider/ProviderRegistry.js";
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

    const reconnectCommand = await prisma.workerCommand.create({ data: { type: "RECONNECT", accountId: account.id } });
    const resyncCommand = await prisma.workerCommand.create({ data: { type: "RESYNC_GROUPS", accountId: account.id } });

    const registry = new ProviderRegistry();
    registry.registerForTesting(account.id, provider);
    const interval = startCommandProcessor(registry, 10);
    try {
      await new Promise((resolve) => setTimeout(resolve, 60)); // several tick intervals while RECONNECT is stuck

      const reconnectMidFlight = await prisma.workerCommand.findUniqueOrThrow({ where: { id: reconnectCommand.id } });
      const resyncMidFlight = await prisma.workerCommand.findUniqueOrThrow({ where: { id: resyncCommand.id } });
      expect(reconnectMidFlight.status).toBe("PROCESSING");
      expect(resyncMidFlight.status).toBe("PENDING"); // never claimed while RECONNECT was still running

      releaseConnect();

      /**
       * POLLED, not a fixed sleep — and the difference is the difference between this test and a
       * flaky one.
       *
       * The half above asserts something does NOT happen (RESYNC_GROUPS is never claimed while
       * RECONNECT runs), and a fixed wait is the only honest way to test an absence. This half
       * asserts something DOES happen, where a fixed wait is an assumption about speed rather than
       * about behaviour. It was 60ms, and it started failing intermittently under full-suite load
       * once RECONNECT began firing a background group sync that RESYNC_GROUPS then joins —
       * genuinely slower, and correct. Waiting for the condition keeps exactly the same assertion
       * while removing the guess.
       */
      const deadline = Date.now() + 5_000;
      let reconnectFinal = await prisma.workerCommand.findUniqueOrThrow({ where: { id: reconnectCommand.id } });
      let resyncFinal = await prisma.workerCommand.findUniqueOrThrow({ where: { id: resyncCommand.id } });
      while ((reconnectFinal.status !== "DONE" || resyncFinal.status !== "DONE") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        reconnectFinal = await prisma.workerCommand.findUniqueOrThrow({ where: { id: reconnectCommand.id } });
        resyncFinal = await prisma.workerCommand.findUniqueOrThrow({ where: { id: resyncCommand.id } });
      }
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

  it("deactivates that account's groups but keeps their settings", async () => {
    // Logging out is "left every group" as far as this app can see, and it is the one case
    // syncGroups' own sweep can never cover — that sweep needs a live provider result, which a
    // logged-out account never produces again. Left active, the rows keep filling the chat inbox
    // with conversations this number cannot reach, and every send fails membership verification.
    const group = await prisma.whatsAppGroup.create({
      data: {
        accountId: account.id,
        whatsappGroupId: `${randomUUID().replace(/-/g, "").slice(0, 12)}-1234567890@g.us`,
        name: `Logout Group ${randomUUID()}`,
        isMonitored: true,
        isActive: true,
        aiAutomationEnabled: true,
      },
    });

    try {
      await prisma.workerCommand.create({ data: { type: "LOGOUT" } });
      await processOneCommand(account.id, new MockProvider());

      const refreshed = await prisma.whatsAppGroup.findUniqueOrThrow({ where: { id: group.id } });
      expect(refreshed.isActive).toBe(false);
      // Deactivate, never erase: reconnecting the SAME number must restore the setup rather than
      // silently wipe it, and syncGroups' upsert flips isActive back on its own.
      expect(refreshed.isMonitored).toBe(true);
      expect(refreshed.aiAutomationEnabled).toBe(true);
    } finally {
      await prisma.whatsAppGroup.delete({ where: { id: group.id } });
    }
  });

  it("never deactivates a different account's groups", async () => {
    const otherAccount = await prisma.whatsAppAccount.create({
      data: { label: `Other Account ${randomUUID()}`, status: "CONNECTED" },
    });
    const otherGroup = await prisma.whatsAppGroup.create({
      data: {
        accountId: otherAccount.id,
        whatsappGroupId: `${randomUUID().replace(/-/g, "").slice(0, 12)}-1234567890@g.us`,
        name: `Other Group ${randomUUID()}`,
        isActive: true,
      },
    });

    try {
      await prisma.workerCommand.create({ data: { type: "LOGOUT" } });
      await processOneCommand(account.id, new MockProvider());

      const refreshed = await prisma.whatsAppGroup.findUniqueOrThrow({ where: { id: otherGroup.id } });
      expect(refreshed.isActive).toBe(true);
    } finally {
      await prisma.whatsAppGroup.delete({ where: { id: otherGroup.id } });
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

/**
 * The button an operator presses must retry like the automatic path does.
 *
 * `accountRegistrySync` has always gone through `connectWithRetry` — three attempts with backoff —
 * so an attempt that never reaches WhatsApp's linking screen gets another go on its own. The
 * RECONNECT command, which is what Connect/Reconnect in the dashboard actually enqueues, called
 * `provider.connect()` exactly once. One miss and there was no second try: the command failed, the
 * account went ERROR, and the only thing that could produce a code again was a person pressing the
 * button again. That is what "the QR keeps missing" looked like from the outside.
 */
describe("RECONNECT: retries a connect that produced nothing", () => {
  // The real schedule is 15s then 45s. What is under test is that a retry HAPPENS and how the
  // command is reported — not how long the pause is — so the wait is shortened rather than sat out.
  const originalDelays = process.env.WHATSAPP_CONNECT_RETRY_DELAYS_MS;
  beforeEach(() => {
    process.env.WHATSAPP_CONNECT_RETRY_DELAYS_MS = "10,10";
  });
  afterEach(() => {
    if (originalDelays === undefined) delete process.env.WHATSAPP_CONNECT_RETRY_DELAYS_MS;
    else process.env.WHATSAPP_CONNECT_RETRY_DELAYS_MS = originalDelays;
  });

  it("tries again after a failed attempt instead of giving up on the first", async () => {
    const provider = new MockProvider();
    // The handler's first guard is the PROVIDER's own status — a RECONNECT into an already-healthy
    // session is deliberately skipped, so a mock left at its CONNECTED default never reaches the
    // connect path at all.
    provider.connectionStatus = "DISCONNECTED";
    let attempts = 0;
    provider.disconnect = async () => {};
    provider.connect = async () => {
      attempts += 1;
      // Fail once, succeed on the retry — the ordinary "WhatsApp Web was slow to bootstrap" case.
      if (attempts === 1) throw new Error("never reached WhatsApp's linking screen");
    };

    await prisma.whatsAppAccount.update({ where: { id: account.id }, data: { status: "DISCONNECTED" } });
    const command = await prisma.workerCommand.create({ data: { type: "RECONNECT" } });
    await processOneCommand(account.id, provider);

    expect(attempts).toBeGreaterThan(1);
    expect((await prisma.workerCommand.findUniqueOrThrow({ where: { id: command.id } })).status).toBe("DONE");
  });

  it("reports a command that failed every attempt, rather than claiming it reconnected", async () => {
    const provider = new MockProvider();
    provider.connectionStatus = "DISCONNECTED";
    provider.disconnect = async () => {};
    provider.connect = async () => {
      throw new Error("never reached WhatsApp's linking screen");
    };

    await prisma.whatsAppAccount.update({ where: { id: account.id }, data: { status: "DISCONNECTED" } });
    const command = await prisma.workerCommand.create({ data: { type: "RECONNECT" } });
    await processOneCommand(account.id, provider);

    const refreshed = await prisma.workerCommand.findUniqueOrThrow({ where: { id: command.id } });
    // Previously this path could only end DONE or throw; a connect that never produced a code has
    // to be reported as the failure it is, with something an operator can act on.
    expect(refreshed.status).toBe("FAILED");
    expect(JSON.stringify(refreshed.result)).toMatch(/did not produce a code/i);
  });
});
