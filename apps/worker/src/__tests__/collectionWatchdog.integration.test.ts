import "./helpers/requireTestDatabase.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@support-automation/db";
import type { WhatsAppAccount, WhatsAppGroup } from "@prisma/client";
import { ProviderRegistry } from "../provider/ProviderRegistry.js";
import { checkCollectionHealth, resetWatchdogState } from "../health/collectionWatchdog.js";
import { MockProvider } from "./mockProvider.js";

/**
 * The subsystem that was supposed to catch the 18 Sep 2026 outage, and had no test coverage at all.
 *
 * Messages stopped being stored at 07:06 and nobody knew until 10:22. Every health mechanism in
 * this worker was pull-based and status-gated — each asked the database which accounts were
 * CONNECTED — so an account that was neither CONNECTED nor DISCONNECTED fell through all of them.
 * The two lines that caused it were unasserted, which means re-narrowing them would have passed CI.
 * These are the assertions that stop that.
 *
 * Every test here was confirmed to fail against the pre-fix watchdog before being kept.
 */

let account: WhatsAppAccount;
/**
 * A second, healthy number. Present because the alert about a broken WhatsApp session travels
 * through the same registry that is broken (defect D3), so "which account carries it" is itself
 * part of what is being tested — not incidental fixture noise.
 */
let spareAccount: WhatsAppAccount;
let group: WhatsAppGroup;
let registry: ProviderRegistry;
let provider: MockProvider;
let spareProvider: MockProvider;

/** Far enough back that the quiet threshold (45m) is comfortably passed on every tick. */
const LONG_AGO = () => new Date(Date.now() - 4 * 60 * 60_000);

beforeAll(async () => {
  account = await prisma.whatsAppAccount.create({
    data: {
      label: `Watchdog Test ${randomUUID()}`,
      status: "CONNECTED",
      // Both are part of the selection: an account that has never connected is being set up, and
      // one with nothing monitored is supposed to be silent. Neither may ever alarm.
      lastConnectedAt: new Date(),
      phoneNumber: `8801${Math.floor(Math.random() * 1_000_000_000)}`,
    },
  });
  spareAccount = await prisma.whatsAppAccount.create({
    data: { label: `Watchdog Spare ${randomUUID()}`, status: "CONNECTED" },
  });
  group = await prisma.whatsAppGroup.create({
    data: {
      accountId: account.id,
      whatsappGroupId: `${randomUUID()}@g.us`,
      name: "Watchdog Test Group",
      isActive: true,
      isMonitored: true,
    },
  });

  // The global destination list is what the alert is queued to. Without it there is nothing to
  // assert against, and the module correctly writes nothing.
  await prisma.automationSettings.upsert({
    where: { id: "global" },
    update: { whatsappNotificationGroupIds: ["watchdog-alerts@g.us"] },
    create: { id: "global", whatsappNotificationGroupIds: ["watchdog-alerts@g.us"] },
  });
});

beforeEach(async () => {
  resetWatchdogState();
  registry = new ProviderRegistry();
  provider = new MockProvider();
  spareProvider = new MockProvider();
  registry.registerForTesting(account.id, provider);
  registry.registerForTesting(spareAccount.id, spareProvider);
  await prisma.notification.deleteMany({ where: { event: "COLLECTION_BROKEN" } });
  await prisma.workerCommand.deleteMany({ where: { accountId: account.id } });
});

afterEach(async () => {
  await prisma.message.deleteMany({ where: { accountId: account.id } });
  await prisma.whatsAppAccount.update({ where: { id: account.id }, data: { status: "CONNECTED" } });
});

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { event: "COLLECTION_BROKEN" } });
  await prisma.message.deleteMany({ where: { accountId: account.id } });
  await prisma.whatsAppGroup.deleteMany({ where: { accountId: account.id } });
  await prisma.whatsAppAccount.delete({ where: { id: account.id } }).catch(() => undefined);
  await prisma.whatsAppAccount.delete({ where: { id: spareAccount.id } }).catch(() => undefined);
  await prisma.$disconnect();
});

/**
 * Puts the account in a connection state the way production does — in the provider AND in the
 * database column.
 *
 * Setting only the provider would leave the row saying CONNECTED, which is exactly the shape the
 * PRE-INCIDENT watchdog selected on. A fixture that does that lets the very narrowing this suite
 * exists to prevent pass every test: verified by re-narrowing the selection to
 * `where: { status: "CONNECTED" }` and watching these go green. `recordConnectionState` writes
 * both, so both is what reality looks like.
 */
async function setStatus(status: "CONNECTED" | "AUTHENTICATION_REQUIRED" | "SESSION_ERROR" | "RECONNECTING" | "DISCONNECTED") {
  provider.connectionStatus = status;
  await prisma.whatsAppAccount.update({ where: { id: account.id }, data: { status } });
}

/** A stored message, so the account is not "has never collected anything" (which never alarms). */
async function storeMessage(at: Date): Promise<void> {
  await prisma.message.create({
    data: {
      accountId: account.id,
      groupId: group.id,
      whatsappMessageId: `wm-${randomUUID()}`,
      chatId: group.whatsappGroupId,
      senderPhone: "8801999999999",
      direction: "INCOMING",
      body: "hello",
      normalizedBody: "hello",
      timestampWa: at,
      processingStatus: "PROCESSED",
    },
  });
}

const findingsForAccount = (findings: Awaited<ReturnType<typeof checkCollectionHealth>>) =>
  findings.filter((f) => f.accountId === account.id);

/** Cleared before every test, so a plain count is unambiguous and needs no JSON-path filter. */
const alertCount = () => prisma.notification.count({ where: { event: "COLLECTION_BROKEN" } });

const alertAccountIds = async () =>
  (await prisma.notification.findMany({ where: { event: "COLLECTION_BROKEN" }, select: { accountId: true } })).map(
    (n) => n.accountId,
  );

describe("a session that needs a person", () => {
  it("raises for AUTHENTICATION_REQUIRED, and never attempts a reconnect", async () => {
    // The half that was missing. Excluding this state from auto-retry is CORRECT — it needs
    // somebody holding the phone, and reconnecting in a loop would rotate a QR nobody is looking
    // at forever. But nothing told anyone, so the number sat waiting indefinitely.
    await storeMessage(LONG_AGO());
    await setStatus("AUTHENTICATION_REQUIRED");

    const findings = findingsForAccount(await checkCollectionHealth(registry));

    expect(findings).toHaveLength(1);
    expect(findings[0]!.problem).toBe("NEEDS_HUMAN");
    // The whole point of not retrying: the provider is left completely alone.
    expect(provider.connectAttempts).toBe(0);
    expect(await alertCount()).toBe(1);
  });

  it("raises for SESSION_ERROR too", async () => {
    await storeMessage(LONG_AGO());
    await setStatus("SESSION_ERROR");

    const findings = findingsForAccount(await checkCollectionHealth(registry));

    expect(findings[0]?.problem).toBe("NEEDS_HUMAN");
    expect(provider.connectAttempts).toBe(0);
  });

  it("stays quiet while an operator is already linking the number", async () => {
    // Somebody deliberately linking a new number produces exactly this state. Telling them their
    // number needs attention while they are the one giving it to it is how an alert channel
    // teaches people to ignore it.
    //
    // RECONNECT is what linking actually enqueues — `setPairingMethod()` queues one on every
    // method change, and the Accounts page's Connect button opens the reconnect dialog. It is the
    // only command that starts a connection attempt, and a connection attempt is the only thing
    // that produces a QR or a link code.
    await storeMessage(LONG_AGO());
    await setStatus("AUTHENTICATION_REQUIRED");
    await prisma.workerCommand.create({
      data: { accountId: account.id, type: "RECONNECT", status: "PENDING" },
    });

    expect(findingsForAccount(await checkCollectionHealth(registry))).toHaveLength(0);
    expect(await alertCount()).toBe(0);
  });
});

describe("a session stuck mid-reconnect", () => {
  it("does not alarm immediately — a real reconnect is allowed to take a moment", async () => {
    await storeMessage(LONG_AGO());
    await setStatus("RECONNECTING");

    expect(findingsForAccount(await checkCollectionHealth(registry))).toHaveLength(0);
  });

  it("raises once it has been stuck past the grace period", async () => {
    // D1, and the actual shape of the outage: RECONNECTING was excluded from recovery, excluded
    // from monitoring, and rendered on the dashboard as "the worker is bringing this session back
    // up" — a promise nothing kept. Only a process restart cleared it.
    //
    // The grace period is read per tick precisely so this is expressible: the first tick starts
    // the clock, the second finds it already past a zero-length grace.
    process.env.COLLECTION_RECONNECTING_GRACE_MINUTES = "0";
    try {
      await storeMessage(LONG_AGO());
      await setStatus("RECONNECTING");

      const findings = findingsForAccount(await checkCollectionHealth(registry));

      expect(findings).toHaveLength(1);
      expect(findings[0]!.problem).toBe("STUCK_RECONNECTING");
      expect(await alertCount()).toBe(1);
    } finally {
      delete process.env.COLLECTION_RECONNECTING_GRACE_MINUTES;
    }
  });
});

describe("a connected session that cannot be read", () => {
  it("treats an unknown probe as a finding rather than agreement — after a second strike", async () => {
    // D2. `fetchMessagesSince` swallows its own enumeration failure and returns [], so the old
    // watchdog read a dead browser as "WhatsApp holds nothing newer" and logged
    // "quiet for 195m and WhatsApp agrees". Its try/catch could never fire; nothing ever threw.
    await storeMessage(LONG_AGO());
    provider.probeFailureReason = "Protocol error: Target closed";

    // One failure is not enough — a single enumeration can fail mid-refresh.
    expect(findingsForAccount(await checkCollectionHealth(registry))).toHaveLength(0);

    const findings = findingsForAccount(await checkCollectionHealth(registry));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.problem).toBe("UNREADABLE");
    expect(findings[0]!.reason).toContain("Target closed");
  });

  it("forgets its strikes as soon as the session answers again", async () => {
    await storeMessage(LONG_AGO());
    provider.probeFailureReason = "Protocol error: Target closed";
    await checkCollectionHealth(registry);

    provider.probeFailureReason = null;
    await checkCollectionHealth(registry); // agrees: quiet, nothing missed

    provider.probeFailureReason = "Protocol error: Target closed";
    // Back to strike one, not straight to an alert — otherwise one bad read weeks ago would make
    // the next one alarm instantly.
    expect(findingsForAccount(await checkCollectionHealth(registry))).toHaveLength(0);
  });
});

describe("a real disagreement", () => {
  it("still reports and sweeps when WhatsApp holds messages we never stored", async () => {
    // The original check, which must keep working: this is proof rather than suspicion, and the
    // reason the watchdog recovers rather than merely alarming.
    await storeMessage(LONG_AGO());
    provider.missedMessages = [
      {
        accountId: account.id,
        whatsappMessageId: `wm-${randomUUID()}`,
        chatId: group.whatsappGroupId,
        whatsappGroupId: group.whatsappGroupId,
        senderPhone: "8801999999999",
        senderName: null,
        direction: "INCOMING",
        body: "are you there?",
        timestampWa: new Date(),
        quotedWhatsappMessageId: null,
        mentionedPhones: [],
      },
    ];

    const findings = findingsForAccount(await checkCollectionHealth(registry));

    expect(findings).toHaveLength(1);
    expect(findings[0]!.problem).toBe("NOT_COLLECTING");
    expect(findings[0]!.missed).toBe(1);
    expect(await alertCount()).toBe(1);
  });
});

describe("which number carries the alert", () => {
  it("sends through a different account than the broken one when there is one", async () => {
    // D3. The WhatsApp channel resolves through the same registry it would be reporting on, so an
    // alert about a dead session routed back through that session is no alert at all.
    await storeMessage(LONG_AGO());
    await setStatus("SESSION_ERROR");

    await checkCollectionHealth(registry);

    expect(await alertAccountIds()).toEqual([spareAccount.id]);
  });

  it("falls back to the affected number itself when it is the only one, and still connected", async () => {
    // The deliberate concession, and the reason this is not simply "never the broken account":
    // most deployments run one number. A session that has stopped COLLECTING has a dead listener;
    // sending is a different path and very likely still works. A possible alert beats a
    // guaranteed silence.
    const soloRegistry = new ProviderRegistry();
    soloRegistry.registerForTesting(account.id, provider);
    await storeMessage(LONG_AGO());
    provider.probeFailureReason = "Protocol error: Target closed";

    await checkCollectionHealth(soloRegistry);
    await checkCollectionHealth(soloRegistry); // second strike

    expect(await alertAccountIds()).toEqual([account.id]);
  });

  it("records that nobody could be told when there is no reachable channel at all", async () => {
    // Worse than the outage, and the one a post-mortem has to be able to find: without this the
    // absence of an alert reads as the absence of a problem, which is how 18 Sep began.
    const soloRegistry = new ProviderRegistry();
    soloRegistry.registerForTesting(account.id, provider);
    await storeMessage(LONG_AGO());
    await setStatus("SESSION_ERROR"); // cannot send either

    await checkCollectionHealth(soloRegistry);

    expect(await alertCount()).toBe(0);
    const logged = await prisma.systemLog.findFirst({
      where: { message: "Collection failure could not be alerted — no channel was reachable" },
      orderBy: { createdAt: "desc" },
    });
    expect(logged).not.toBeNull();
  });
});

describe("suppression", () => {
  it("alerts once for an unresolved problem rather than on every tick", async () => {
    // Fifteen minutes apart, forever, would bury the alert under itself.
    await storeMessage(LONG_AGO());
    await setStatus("AUTHENTICATION_REQUIRED");

    await checkCollectionHealth(registry);
    await checkCollectionHealth(registry);
    await checkCollectionHealth(registry);

    expect(await alertCount()).toBe(1);
  });

  it("alerts again when a different problem replaces the first", async () => {
    // A new failure must never be silenced by an earlier one's recent alert — they need different
    // responses, and the second is the one that is now true.
    await storeMessage(LONG_AGO());
    await setStatus("AUTHENTICATION_REQUIRED");
    await checkCollectionHealth(registry);

    await setStatus("CONNECTED");
    provider.probeFailureReason = "Protocol error: Target closed";
    await checkCollectionHealth(registry);
    await checkCollectionHealth(registry);

    expect(await alertCount()).toBe(2);
  });
});

describe("what must never alarm", () => {
  it("says nothing about an account that is in no groups at all", async () => {
    // A spare number in nothing is supposed to be silent. Alarming here would make the alert
    // useless within a day.
    await storeMessage(LONG_AGO());
    await setStatus("AUTHENTICATION_REQUIRED");
    await prisma.whatsAppGroup.update({ where: { id: group.id }, data: { isActive: false } });

    expect(findingsForAccount(await checkCollectionHealth(registry))).toHaveLength(0);

    await prisma.whatsAppGroup.update({ where: { id: group.id }, data: { isActive: true } });
  });

  it("but DOES watch an account whose groups are active and simply not monitored", async () => {
    // Production on 24 Sep 2026: an inbox-only deployment with zero monitored groups, silently
    // collecting nothing for hours, skipped by the old monitored-only selection. Monitoring
    // governs automation, not whether messages must arrive.
    await storeMessage(LONG_AGO());
    await setStatus("AUTHENTICATION_REQUIRED");
    await prisma.whatsAppGroup.update({ where: { id: group.id }, data: { isMonitored: false } });

    expect(findingsForAccount(await checkCollectionHealth(registry))).toHaveLength(1);

    await prisma.whatsAppGroup.update({ where: { id: group.id }, data: { isMonitored: true } });
  });

  it("says nothing about a connected account that stored a message recently", async () => {
    await storeMessage(new Date());

    expect(findingsForAccount(await checkCollectionHealth(registry))).toHaveLength(0);
  });

  it("says nothing about an account that has never stored anything", async () => {
    // Being set up, not gone deaf.
    await setStatus("CONNECTED");

    expect(findingsForAccount(await checkCollectionHealth(registry))).toHaveLength(0);
  });

  it("gives a freshly dropped session time for automatic recovery to work", async () => {
    // recoverIfDropped owns DISCONNECTED and retries every five minutes. Alerting on every
    // transient drop the system fixes by itself is how an alert channel stops being read.
    await storeMessage(LONG_AGO());
    await setStatus("DISCONNECTED");

    expect(findingsForAccount(await checkCollectionHealth(registry))).toHaveLength(0);
  });
});
