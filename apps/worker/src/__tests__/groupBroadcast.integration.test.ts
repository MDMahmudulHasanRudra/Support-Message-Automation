import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@support-automation/db";
import { buildGroupBroadcastIdempotencyKey } from "@support-automation/shared";
import type { AutomationSettings, GroupBroadcastSettings, Prisma, WhatsAppAccount, WhatsAppGroup } from "@prisma/client";
import { processOne, recoverStuckOutboundMessages } from "../queue/outboundQueueProcessor.js";
import { MockProvider } from "./mockProvider.js";

/**
 * Covers the Group Message Sender's worker-side send mechanics (queue
 * sequencing, rate limiting, membership verification, retries, kill
 * switch, crash recovery, idempotency). Excel validation and group-name
 * matching (unmatched/ambiguous/duplicate-in-file) are pure and covered
 * separately in packages/shared/src/__tests__/groupBroadcast.test.ts — this
 * file only exercises what actually depends on the queue processor and a
 * real Postgres instance, same reasoning as pipeline.integration.test.ts.
 */

let originalSettings: AutomationSettings;
let originalBroadcastSettings: GroupBroadcastSettings;
let account: WhatsAppAccount;

function uniqueGroupJid(): string {
  return `${randomUUID().replace(/-/g, "").slice(0, 10)}-1234567890@g.us`;
}

async function resetAutomationSettings(overrides: Partial<Prisma.AutomationSettingsUpdateInput> = {}) {
  await prisma.automationSettings.update({
    where: { id: "global" },
    data: { automationEnabled: true, rateLimitingEnabled: false, ...overrides },
  });
}

async function resetBroadcastSettings(overrides: Partial<Prisma.GroupBroadcastSettingsUpdateInput> = {}) {
  await prisma.groupBroadcastSettings.update({
    where: { id: "global" },
    data: {
      delayMinMs: 0,
      delayMaxMs: 0,
      maxPerMinute: 100,
      maxPerJob: 200,
      retryMaxAttempts: 2,
      duplicateGroupCooldownMinutes: 60,
      ...overrides,
    },
  });
}

async function makeGroup(overrides: Partial<Pick<WhatsAppGroup, "name" | "whatsappGroupId">> = {}) {
  return prisma.whatsAppGroup.create({
    data: {
      accountId: account.id,
      whatsappGroupId: overrides.whatsappGroupId ?? uniqueGroupJid(),
      name: overrides.name ?? `Test Group ${randomUUID().slice(0, 8)}`,
      lastSyncedAt: new Date(),
    },
  });
}

async function makeJob(overrides: Partial<Prisma.GroupBroadcastJobUncheckedCreateInput> = {}) {
  const settings = await prisma.groupBroadcastSettings.findUniqueOrThrow({ where: { id: "global" } });
  return prisma.groupBroadcastJob.create({
    data: {
      accountId: account.id,
      source: "MANUAL",
      defaultMessage: "Hello from the test suite.",
      totalRequested: 1,
      queuedCount: 1,
      delayMinMs: settings.delayMinMs,
      delayMaxMs: settings.delayMaxMs,
      maxPerMinute: settings.maxPerMinute,
      maxPerJob: settings.maxPerJob,
      retryMaxAttempts: settings.retryMaxAttempts,
      ...overrides,
    },
  });
}

async function queueBroadcastMessage(params: { job: { id: string }; group: WhatsAppGroup; message?: string; scheduledAt?: Date }) {
  return prisma.outboundMessage.create({
    data: {
      accountId: account.id,
      chatId: params.group.whatsappGroupId,
      toPhone: params.group.whatsappGroupId,
      body: params.message ?? "Hello from the test suite.",
      actionType: "GROUP_BROADCAST",
      idempotencyKey: buildGroupBroadcastIdempotencyKey({ broadcastJobId: params.job.id, groupId: params.group.id }),
      groupId: params.group.id,
      groupNameSnapshot: params.group.name,
      broadcastJobId: params.job.id,
      scheduledAt: params.scheduledAt ?? new Date(),
    },
  });
}

beforeAll(async () => {
  originalSettings = await prisma.automationSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
  originalBroadcastSettings = await prisma.groupBroadcastSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
});

afterAll(async () => {
  await prisma.automationSettings.update({ where: { id: "global" }, data: originalSettings as unknown as Prisma.AutomationSettingsUpdateInput });
  await prisma.groupBroadcastSettings.update({
    where: { id: "global" },
    data: originalBroadcastSettings as unknown as Prisma.GroupBroadcastSettingsUpdateInput,
  });
});

beforeEach(async () => {
  await resetAutomationSettings();
  await resetBroadcastSettings();
  account = await prisma.whatsAppAccount.create({ data: { label: `Broadcast Test Account ${randomUUID()}`, status: "CONNECTED" } });
});

afterEach(async () => {
  // Cascades: WhatsAppGroup, GroupBroadcastJob, and OutboundMessage all onDelete: Cascade from WhatsAppAccount.
  await prisma.whatsAppAccount.delete({ where: { id: account.id } });
});

describe("Scenario 1: one matched group", () => {
  it("sends the single queued message and marks it SENT", async () => {
    const group = await makeGroup();
    const job = await makeJob({ queuedCount: 1, totalRequested: 1 });
    await queueBroadcastMessage({ job, group });

    const provider = new MockProvider();
    await processOne(provider);

    const row = await prisma.outboundMessage.findFirstOrThrow({ where: { broadcastJobId: job.id } });
    expect(row.status).toBe("SENT");
    expect(row.providerMessageId).toBe("mock-id");
    expect(provider.sentMessages).toEqual([{ chatId: group.whatsappGroupId, body: "Hello from the test suite." }]);

    const refreshedJob = await prisma.groupBroadcastJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(refreshedJob.status).toBe("COMPLETED");
    expect(refreshedJob.startedAt).not.toBeNull();
    expect(refreshedJob.completedAt).not.toBeNull();
  });
});

describe("Scenario 2: multiple matched groups", () => {
  it("sends every queued message in scheduledAt order, one per processOne tick", async () => {
    const groups = await Promise.all([makeGroup(), makeGroup(), makeGroup()]);
    const job = await makeJob({ queuedCount: 3, totalRequested: 3 });
    const now = Date.now();
    for (const [i, group] of groups.entries()) {
      await queueBroadcastMessage({ job, group, scheduledAt: new Date(now + i * 10) });
    }

    const provider = new MockProvider();
    for (let i = 0; i < 3; i++) {
      const handled = await processOne(provider);
      expect(handled).toBe(true);
    }

    expect(provider.sentMessages.map((m) => m.chatId)).toEqual(groups.map((g) => g.whatsappGroupId));
    const sentCount = await prisma.outboundMessage.count({ where: { broadcastJobId: job.id, status: "SENT" } });
    expect(sentCount).toBe(3);
  });

  it("respects the job's own per-minute cap independently of the account-wide limits", async () => {
    await resetBroadcastSettings({ maxPerMinute: 1 });
    const groups = await Promise.all([makeGroup(), makeGroup()]);
    const job = await makeJob({ queuedCount: 2, totalRequested: 2, maxPerMinute: 1 });
    await queueBroadcastMessage({ job, group: groups[0]! });
    await queueBroadcastMessage({ job, group: groups[1]! });

    const provider = new MockProvider();
    await processOne(provider); // sends the first
    await processOne(provider); // job's maxPerMinute=1 already hit -> must defer, not send

    expect(provider.sentMessages).toHaveLength(1);
    const rows = await prisma.outboundMessage.findMany({ where: { broadcastJobId: job.id } });
    expect(rows.filter((r) => r.status === "SENT")).toHaveLength(1);
    expect(rows.filter((r) => r.status === "PENDING")).toHaveLength(1); // deferred, not failed/cancelled
  });
});

describe("Scenario 7 & 8: queue/provider failure -> FAILED with retry, then exhausted", () => {
  it("retries on provider failure and marks FAILED only once retryMaxAttempts is exhausted", async () => {
    await resetBroadcastSettings({ retryMaxAttempts: 2 });
    const group = await makeGroup();
    const job = await makeJob({ queuedCount: 1, totalRequested: 1, retryMaxAttempts: 2 });
    await queueBroadcastMessage({ job, group });

    const provider = new MockProvider();
    provider.nextResult = { success: false, error: "simulated provider failure" };

    await processOne(provider); // attempt 1 -> PENDING again (retry scheduled)
    let row = await prisma.outboundMessage.findFirstOrThrow({ where: { broadcastJobId: job.id } });
    expect(row.status).toBe("PENDING");
    expect(row.attemptCount).toBe(1);
    expect(row.failureReason).toMatch(/simulated provider failure/);

    // Force the retry to be due now instead of waiting out the real backoff delay.
    await prisma.outboundMessage.update({ where: { id: row.id }, data: { scheduledAt: new Date() } });
    await processOne(provider); // attempt 2 -> exhausted -> FAILED
    row = await prisma.outboundMessage.findFirstOrThrow({ where: { broadcastJobId: job.id } });
    expect(row.status).toBe("FAILED");
    expect(row.attemptCount).toBe(2);

    const refreshedJob = await prisma.groupBroadcastJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(refreshedJob.status).toBe("COMPLETED"); // no rows left PENDING/PROCESSING
  });

  it("marks FAILED when the provider throws, not just when it returns success:false", async () => {
    await resetBroadcastSettings({ retryMaxAttempts: 1 });
    const group = await makeGroup();
    const job = await makeJob({ queuedCount: 1, totalRequested: 1, retryMaxAttempts: 1 });
    await queueBroadcastMessage({ job, group });

    const provider = new MockProvider();
    provider.sendMessage = async () => {
      throw new Error("simulated network error");
    };

    await processOne(provider);
    const row = await prisma.outboundMessage.findFirstOrThrow({ where: { broadcastJobId: job.id } });
    expect(row.status).toBe("FAILED");
    expect(row.failureReason).toMatch(/simulated network error/);
  });
});

describe("Scenario 9: manual retry of a FAILED message", () => {
  it("resends successfully once reset to PENDING (mirrors the retry action's own update)", async () => {
    const group = await makeGroup();
    const job = await makeJob({ queuedCount: 1, totalRequested: 1 });
    const message = await queueBroadcastMessage({ job, group });
    await prisma.outboundMessage.update({
      where: { id: message.id },
      data: { status: "FAILED", attemptCount: 2, failureReason: "simulated prior failure" },
    });

    // What retryFailedBroadcastMessages (apps/web) does to a FAILED row.
    await prisma.outboundMessage.update({
      where: { id: message.id },
      data: { status: "PENDING", attemptCount: 0, failureReason: null, scheduledAt: new Date() },
    });

    const provider = new MockProvider();
    await processOne(provider);

    const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { id: message.id } });
    expect(row.status).toBe("SENT");
    expect(row.failureReason).toBeNull();
  });
});

describe("Scenario 10: kill switch stops a running job", () => {
  it("cancels the pending message and stamps the job STOPPED_KILL_SWITCH", async () => {
    const group = await makeGroup();
    const job = await makeJob({ queuedCount: 1, totalRequested: 1 });
    await queueBroadcastMessage({ job, group });
    await resetAutomationSettings({ automationEnabled: false });

    const provider = new MockProvider();
    await processOne(provider);

    const row = await prisma.outboundMessage.findFirstOrThrow({ where: { broadcastJobId: job.id } });
    expect(row.status).toBe("CANCELLED");
    expect(provider.sentMessages).toHaveLength(0);

    const refreshedJob = await prisma.groupBroadcastJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(refreshedJob.status).toBe("STOPPED_KILL_SWITCH");
  });

  it("leaves already-SENT messages untouched when the kill switch stops the rest of the job", async () => {
    const groups = await Promise.all([makeGroup(), makeGroup()]);
    const job = await makeJob({ queuedCount: 2, totalRequested: 2 });
    await queueBroadcastMessage({ job, group: groups[0]!, scheduledAt: new Date(Date.now() - 10) });
    await queueBroadcastMessage({ job, group: groups[1]!, scheduledAt: new Date() });

    const provider = new MockProvider();
    await processOne(provider); // sends the first while automation is still enabled

    await resetAutomationSettings({ automationEnabled: false });
    await processOne(provider); // the second is now cancelled by the kill switch

    const rows = await prisma.outboundMessage.findMany({ where: { broadcastJobId: job.id } });
    expect(rows.find((r) => r.groupId === groups[0]!.id)?.status).toBe("SENT");
    expect(rows.find((r) => r.groupId === groups[1]!.id)?.status).toBe("CANCELLED");
  });

  it("cancels a row belonging to an explicitly stopped job even while automation stays enabled", async () => {
    const group = await makeGroup();
    const job = await makeJob({ queuedCount: 1, totalRequested: 1, status: "CANCELLED", cancelledAt: new Date() });
    await queueBroadcastMessage({ job, group });

    const provider = new MockProvider();
    await processOne(provider);

    const row = await prisma.outboundMessage.findFirstOrThrow({ where: { broadcastJobId: job.id } });
    expect(row.status).toBe("CANCELLED");
    expect(provider.sentMessages).toHaveLength(0);
  });
});

describe("Scenario 11: worker restart -> crash recovery, no duplicate send", () => {
  it("requeues a stuck PROCESSING broadcast row to PENDING without creating a duplicate", async () => {
    const group = await makeGroup();
    const job = await makeJob({ queuedCount: 1, totalRequested: 1 });
    const message = await queueBroadcastMessage({ job, group });
    await prisma.outboundMessage.update({ where: { id: message.id }, data: { status: "PROCESSING" } });
    await prisma.$executeRaw`UPDATE "OutboundMessage" SET "updatedAt" = NOW() - INTERVAL '10 minutes' WHERE id = ${message.id}`;

    const recovered = await recoverStuckOutboundMessages();
    expect(recovered).toBeGreaterThanOrEqual(1);

    const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { id: message.id } });
    expect(row.status).toBe("PENDING");
    expect(await prisma.outboundMessage.count({ where: { broadcastJobId: job.id } })).toBe(1);

    const provider = new MockProvider();
    await processOne(provider);
    expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { id: message.id } })).status).toBe("SENT");
  });
});

describe("Scenario 12: duplicate-send prevention", () => {
  it("rejects a second queue row for the same (job, group) pair via the idempotency key", async () => {
    const group = await makeGroup();
    const job = await makeJob({ queuedCount: 1, totalRequested: 1 });
    await queueBroadcastMessage({ job, group });

    await expect(queueBroadcastMessage({ job, group })).rejects.toMatchObject({ code: "P2002" });
    expect(await prisma.outboundMessage.count({ where: { broadcastJobId: job.id } })).toBe(1);
  });
});

describe("Membership verification (safety requirement: never send blindly)", () => {
  it("marks the message SKIPPED, not sent, when the provider reports the account is no longer a member", async () => {
    const group = await makeGroup();
    const job = await makeJob({ queuedCount: 1, totalRequested: 1 });
    await queueBroadcastMessage({ job, group });

    const provider = new MockProvider();
    provider.defaultMembership = false;
    await processOne(provider);

    const row = await prisma.outboundMessage.findFirstOrThrow({ where: { broadcastJobId: job.id } });
    expect(row.status).toBe("SKIPPED");
    expect(row.failureReason).toMatch(/Membership could not be verified/);
    expect(provider.sentMessages).toHaveLength(0);
  });
});
