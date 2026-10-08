import "./helpers/requireTestDatabase.js";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma, rawPrisma } from "./helpers/projectFixtures.js";
import { createProjectWithDefaults } from "@support-automation/db";
import type { WhatsAppAccount, WhatsAppGroup } from "@prisma/client";
import type { RawIncomingMessage } from "../pipeline/types.js";
import { recordConnectionState } from "../provider/openwa/connectionState.js";
import { reconcileAccountStatusesOnBoot } from "../recovery.js";
import { catchUpMissedMessages } from "../pipeline/catchUpMissedMessages.js";
import { ProviderRegistry } from "../provider/ProviderRegistry.js";
import { checkCollectionHealth, resetWatchdogState } from "../health/collectionWatchdog.js";
import { MockProvider } from "./mockProvider.js";

/**
 * Collection gaps (SUPPORT_INTELLIGENCE_IMPLEMENTATION_AUDIT.md §H): every way collection stops opens
 * one gap, collection resuming closes it, and the catch-up sweep's result is attached to it — so a
 * report can say "data may be incomplete between 14:20 and 15:05" and whether it was recovered.
 */

const HOUR = 3_600_000;
let account: WhatsAppAccount;
let group: WhatsAppGroup;
const extraAccounts: string[] = [];
let bizId = "";
let ownerId = "";

const gaps = () => prisma.collectionGap.findMany({ where: { accountId: account.id }, orderBy: { startedAt: "asc" } });
const openGaps = async () => (await gaps()).filter((g) => g.endedAt === null);

function missed(at: Date): RawIncomingMessage {
  return {
    accountId: account.id,
    whatsappMessageId: `gap-${randomUUID()}`,
    chatId: group.whatsappGroupId,
    whatsappGroupId: group.whatsappGroupId,
    senderPhone: "8801999999999",
    senderName: null,
    direction: "INCOMING",
    body: "is anyone there?",
    timestampWa: at,
    quotedWhatsappMessageId: null,
    mentionedPhones: [],
  };
}

async function storeMessage(at: Date) {
  await prisma.message.create({
    data: {
      accountId: account.id, groupId: group.id, whatsappMessageId: `gap-${randomUUID()}`, chatId: group.whatsappGroupId,
      senderPhone: "8801999999999", direction: "INCOMING", body: "hello", normalizedBody: "hello", timestampWa: at, processingStatus: "PROCESSED",
    },
  });
}

beforeEach(async () => {
  account = await prisma.whatsAppAccount.create({
    data: { label: `Gap ${randomUUID()}`, status: "CONNECTED", lastConnectedAt: new Date(), phoneNumber: `8801${Math.floor(Math.random() * 1e9)}` },
  });
  group = await prisma.whatsAppGroup.create({
    data: { accountId: account.id, whatsappGroupId: `${randomUUID()}@g.us`, name: "Gap group", isActive: true, isMonitored: true },
  });
});

afterEach(async () => {
  await prisma.whatsAppAccount.delete({ where: { id: account.id } }).catch(() => undefined);
});

afterAll(async () => {
  for (const id of extraAccounts) await rawPrisma.whatsAppAccount.delete({ where: { id } }).catch(() => undefined);
  if (bizId) {
    const tables = (
      await rawPrisma.$queryRaw<Array<{ table_name: string }>>`SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`
    ).map((r) => r.table_name);
    for (let pass = 0; pass < 4; pass++) {
      for (const t of tables) await rawPrisma.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "projectId" = $1`, bizId).catch(() => undefined);
    }
    await rawPrisma.project.deleteMany({ where: { id: bizId } });
  }
  if (ownerId) {
    await rawPrisma.projectAccess.deleteMany({ where: { userId: ownerId } });
    await rawPrisma.user.deleteMany({ where: { id: ownerId } });
  }
  await prisma.$disconnect();
});

describe("the session leaving and reaching CONNECTED", () => {
  it("opens one gap when collection stops and closes it when it resumes", async () => {
    await recordConnectionState(account.id, "DISCONNECTED");
    let rows = await gaps();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cause: "DISCONNECTED", endedAt: null, recoveryStatus: null, projectId: account.projectId });

    // Still down, through several states: the same gap, not three.
    await recordConnectionState(account.id, "RECONNECTING");
    await recordConnectionState(account.id, "QR_AVAILABLE");
    expect(await gaps()).toHaveLength(1);

    await recordConnectionState(account.id, "CONNECTED");
    rows = await gaps();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.endedAt).not.toBeNull();
    expect(rows[0]!.endedAt!.getTime()).toBeGreaterThanOrEqual(rows[0]!.startedAt.getTime());
  });

  it("a number being linked for the first time is not a gap — it never collected", async () => {
    await prisma.whatsAppAccount.update({ where: { id: account.id }, data: { status: "AUTHENTICATION_REQUIRED" } });
    await recordConnectionState(account.id, "QR_AVAILABLE");
    await recordConnectionState(account.id, "AUTHENTICATED");
    await recordConnectionState(account.id, "CONNECTED");
    expect(await gaps()).toHaveLength(0);
  });

  it("the gap belongs to the account's own project", async () => {
    const tag = randomUUID().slice(0, 8);
    const owner = await rawPrisma.user.create({ data: { username: `gap_${tag}`, email: `gap_${tag}@example.test`, name: "Gap", passwordHash: "x" } });
    ownerId = owner.id;
    const biz = await createProjectWithDefaults({ name: `Gap Biz ${tag}`, slug: `gap-biz-${tag}`, status: "ACTIVE", creatorUserId: owner.id }, rawPrisma);
    bizId = biz.id;
    const bizAccount = await rawPrisma.whatsAppAccount.create({ data: { projectId: biz.id, label: "Gap Biz", status: "CONNECTED", lastConnectedAt: new Date() } });
    await recordConnectionState(bizAccount.id, "DISCONNECTED");
    const row = await rawPrisma.collectionGap.findFirstOrThrow({ where: { accountId: bizAccount.id } });
    expect(row.projectId).toBe(biz.id);
  });
});

describe("a worker restart", () => {
  it("opens a gap from the last heartbeat — when collection really stopped, not when the worker came back", async () => {
    const lastHeartbeat = new Date(Date.now() - 20 * 60_000);
    await prisma.whatsAppAccount.update({ where: { id: account.id }, data: { lastHeartbeatAt: lastHeartbeat } });
    await reconcileAccountStatusesOnBoot();
    const [row] = await openGaps();
    expect(row).toMatchObject({ cause: "WORKER_RESTART" });
    expect(row!.startedAt.getTime()).toBe(lastHeartbeat.getTime());
    expect((await prisma.whatsAppAccount.findUniqueOrThrow({ where: { id: account.id } })).status).toBe("DISCONNECTED");
  });
});

describe("what the catch-up sweep recovered", () => {
  async function gapThenReconnect(checkpointAgoMs: number | null) {
    await recordConnectionState(account.id, "DISCONNECTED");
    if (checkpointAgoMs !== null) {
      await prisma.processingCheckpoint.create({ data: { accountId: account.id, lastProcessedTimestampWa: new Date(Date.now() - checkpointAgoMs) } });
    }
    await recordConnectionState(account.id, "CONNECTED");
  }

  it("RECOVERED, with the count and where the sweep read from", async () => {
    await gapThenReconnect(2 * HOUR);
    const provider = new MockProvider();
    provider.missedMessages = [missed(new Date(Date.now() - HOUR))];
    await catchUpMissedMessages(account.id, provider);
    const [row] = await gaps();
    expect(row).toMatchObject({ recoveryStatus: "RECOVERED", recoveredCount: 1, recoveryNote: null });
    expect(row!.recoveredFrom!.getTime()).toBeLessThanOrEqual(Date.now() - 2 * HOUR + 1000);
  });

  it("FAILED when the session could not be read — not 'nothing was missed'", async () => {
    await gapThenReconnect(2 * HOUR);
    const provider = new MockProvider();
    provider.probeFailureReason = "Protocol error: Target closed";
    await catchUpMissedMessages(account.id, provider);
    const [row] = await gaps();
    expect(row!.recoveryStatus).toBe("FAILED");
    expect(row!.recoveryNote).toContain("Target closed");
  });

  it("PARTIAL when the gap began before the sweep's 12-hour reach", async () => {
    await gapThenReconnect(20 * HOUR);
    await catchUpMissedMessages(account.id, new MockProvider());
    const [row] = await gaps();
    expect(row!.recoveryStatus).toBe("PARTIAL");
    expect(row!.recoveryNote).toContain("12 hours");
  });

  it("NOT_ATTEMPTED when the account had never processed a message", async () => {
    await gapThenReconnect(null);
    await catchUpMissedMessages(account.id, new MockProvider());
    expect((await gaps())[0]!.recoveryStatus).toBe("NOT_ATTEMPTED");
  });

  it("a gap keeps its recovery: a later sweep does not overwrite it", async () => {
    await gapThenReconnect(2 * HOUR);
    await catchUpMissedMessages(account.id, new MockProvider());
    const failing = new MockProvider();
    failing.probeFailureReason = "Protocol error: Target closed";
    await catchUpMissedMessages(account.id, failing);
    expect((await gaps())[0]!.recoveryStatus).toBe("RECOVERED");
  });

  it("an ordinary reconnect with no gap records nothing", async () => {
    await prisma.processingCheckpoint.create({ data: { accountId: account.id, lastProcessedTimestampWa: new Date(Date.now() - HOUR) } });
    await catchUpMissedMessages(account.id, new MockProvider());
    expect(await gaps()).toHaveLength(0);
  });
});

describe("the watchdog", () => {
  it("opens a gap from the last stored message when the listener is deaf, and closes it once messages arrive", async () => {
    const lastStored = new Date(Date.now() - 4 * HOUR);
    await storeMessage(lastStored);
    await prisma.processingCheckpoint.create({ data: { accountId: account.id, lastProcessedTimestampWa: lastStored } });
    resetWatchdogState();
    const registry = new ProviderRegistry();
    const provider = new MockProvider();
    registry.registerForTesting(account.id, provider);
    provider.missedMessages = [missed(new Date(Date.now() - 2 * HOUR))];

    await checkCollectionHealth(registry);
    let [row] = await gaps();
    expect(row).toMatchObject({ cause: "NOT_COLLECTING", endedAt: null, recoveryStatus: "RECOVERED", recoveredCount: 1 });
    expect(row!.startedAt.getTime()).toBe(lastStored.getTime());

    await storeMessage(new Date());
    await checkCollectionHealth(registry);
    [row] = await gaps();
    expect(row!.endedAt).not.toBeNull();
  });

  it("an outage that began before gaps were recorded still gets one when the watchdog sees it", async () => {
    await storeMessage(new Date(Date.now() - 4 * HOUR));
    await prisma.whatsAppAccount.update({ where: { id: account.id }, data: { status: "SESSION_ERROR" } });
    resetWatchdogState();
    const registry = new ProviderRegistry();
    const provider = new MockProvider();
    provider.connectionStatus = "SESSION_ERROR";
    registry.registerForTesting(account.id, provider);
    await checkCollectionHealth(registry);
    expect((await openGaps()).map((g) => g.cause)).toEqual(["NEEDS_HUMAN"]);
  });
});

describe("one open gap per account", () => {
  it("is a database rule, not a convention", async () => {
    await prisma.collectionGap.create({ data: { accountId: account.id, cause: "A", startedAt: new Date() } });
    await expect(prisma.collectionGap.create({ data: { accountId: account.id, cause: "B", startedAt: new Date() } })).rejects.toThrow();
  });
});
