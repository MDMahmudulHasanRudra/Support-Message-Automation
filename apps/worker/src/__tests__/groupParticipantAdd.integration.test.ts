import "./helpers/requireTestDatabase.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@support-automation/db";
import type { AutomationSettings, GroupParticipantAddSettings, Prisma, WhatsAppAccount, WhatsAppGroup } from "@prisma/client";
import { processOne, recoverStuckParticipantAddItems } from "../queue/groupParticipantAddProcessor.js";
import { MockProvider } from "./mockProvider.js";

/**
 * Covers the Add-to-Groups worker-side mechanics (queue sequencing, job
 * rate limiting, membership verification, retries, kill switch, crash
 * recovery) — mirrors groupBroadcast.integration.test.ts's structure since
 * both queues share the same claim/throttle/lifecycle shape.
 */

let originalSettings: AutomationSettings;
let originalAddSettings: GroupParticipantAddSettings;
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

async function resetAddSettings(overrides: Partial<Prisma.GroupParticipantAddSettingsUpdateInput> = {}) {
  await prisma.groupParticipantAddSettings.update({
    where: { id: "global" },
    data: { delayMinMs: 0, delayMaxMs: 0, maxPerMinute: 100, maxPerJob: 100, retryMaxAttempts: 2, ...overrides },
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

async function makeJob(overrides: Partial<Prisma.GroupParticipantAddJobUncheckedCreateInput> = {}) {
  const settings = await prisma.groupParticipantAddSettings.findUniqueOrThrow({ where: { id: "global" } });
  return prisma.groupParticipantAddJob.create({
    data: {
      accountId: account.id,
      phoneNumbers: ["8801000000000"],
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

async function queueItem(params: {
  job: { id: string };
  group: WhatsAppGroup;
  scheduledAt?: Date;
  phoneNumber?: string;
}) {
  return prisma.groupParticipantAddItem.create({
    data: {
      jobId: params.job.id,
      groupId: params.group.id,
      groupNameSnapshot: params.group.name,
      // Defaults to the same number makeJob() queues, so every existing test reads unchanged.
      phoneNumber: params.phoneNumber ?? "8801000000000",
      scheduledAt: params.scheduledAt ?? new Date(),
    },
  });
}

beforeAll(async () => {
  originalSettings = await prisma.automationSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
  originalAddSettings = await prisma.groupParticipantAddSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
});

afterAll(async () => {
  await prisma.automationSettings.update({ where: { id: "global" }, data: originalSettings as unknown as Prisma.AutomationSettingsUpdateInput });
  await prisma.groupParticipantAddSettings.update({
    where: { id: "global" },
    data: originalAddSettings as unknown as Prisma.GroupParticipantAddSettingsUpdateInput,
  });
});

beforeEach(async () => {
  await resetAutomationSettings();
  await resetAddSettings();
  account = await prisma.whatsAppAccount.create({ data: { label: `Participant Add Test Account ${randomUUID()}`, status: "CONNECTED" } });
});

afterEach(async () => {
  // Cascades: WhatsAppGroup, GroupParticipantAddJob, and GroupParticipantAddItem all onDelete: Cascade from WhatsAppAccount.
  await prisma.whatsAppAccount.delete({ where: { id: account.id } });
});

describe("Scenario 1: one matched group", () => {
  it("adds the number to the single queued group and marks it ADDED", async () => {
    const group = await makeGroup();
    const job = await makeJob({ queuedCount: 1, totalRequested: 1 });
    await queueItem({ job, group });

    const provider = new MockProvider();
    await processOne(provider);

    const row = await prisma.groupParticipantAddItem.findFirstOrThrow({ where: { jobId: job.id } });
    expect(row.status).toBe("ADDED");
    expect(provider.addedParticipants).toEqual([{ chatId: group.whatsappGroupId, phoneNumber: "8801000000000" }]);

    const refreshedJob = await prisma.groupParticipantAddJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(refreshedJob.status).toBe("COMPLETED");
    expect(refreshedJob.startedAt).not.toBeNull();
    expect(refreshedJob.completedAt).not.toBeNull();
  });
});

describe("Scenario 2: multiple matched groups", () => {
  it("processes every queued item in scheduledAt order, one per processOne tick", async () => {
    const groups = await Promise.all([makeGroup(), makeGroup(), makeGroup()]);
    const job = await makeJob({ queuedCount: 3, totalRequested: 3 });
    const now = Date.now();
    for (const [i, group] of groups.entries()) {
      await queueItem({ job, group, scheduledAt: new Date(now + i * 10) });
    }

    const provider = new MockProvider();
    for (let i = 0; i < 3; i++) {
      const handled = await processOne(provider);
      expect(handled).toBe(true);
    }

    expect(provider.addedParticipants.map((p) => p.chatId)).toEqual(groups.map((g) => g.whatsappGroupId));
    const addedCount = await prisma.groupParticipantAddItem.count({ where: { jobId: job.id, status: "ADDED" } });
    expect(addedCount).toBe(3);
  });

  it("respects the job's own per-minute cap independently of the account-wide limits", async () => {
    await resetAddSettings({ maxPerMinute: 1 });
    const groups = await Promise.all([makeGroup(), makeGroup()]);
    const job = await makeJob({ queuedCount: 2, totalRequested: 2, maxPerMinute: 1 });
    await queueItem({ job, group: groups[0]! });
    await queueItem({ job, group: groups[1]! });

    const provider = new MockProvider();
    await processOne(provider); // adds to the first
    await processOne(provider); // job's maxPerMinute=1 already hit -> must defer, not add

    expect(provider.addedParticipants).toHaveLength(1);
    const rows = await prisma.groupParticipantAddItem.findMany({ where: { jobId: job.id } });
    expect(rows.filter((r) => r.status === "ADDED")).toHaveLength(1);
    expect(rows.filter((r) => r.status === "PENDING")).toHaveLength(1); // deferred, not failed/cancelled
  });
});

describe("Scenario 3: provider failure -> retry, then exhausted", () => {
  it("retries on provider failure and marks FAILED only once retryMaxAttempts is exhausted", async () => {
    await resetAddSettings({ retryMaxAttempts: 2 });
    const group = await makeGroup();
    const job = await makeJob({ queuedCount: 1, totalRequested: 1, retryMaxAttempts: 2 });
    await queueItem({ job, group });

    const provider = new MockProvider();
    provider.nextAddParticipantResult = { success: false, error: "INSUFFICIENT_PERMISSIONS" };

    await processOne(provider); // attempt 1 -> PENDING again (retry scheduled)
    let row = await prisma.groupParticipantAddItem.findFirstOrThrow({ where: { jobId: job.id } });
    expect(row.status).toBe("PENDING");
    expect(row.attemptCount).toBe(1);
    // The raw code is kept for diagnosis, but an operator must be told what to actually do:
    // a bare INSUFFICIENT_PERMISSIONS gives them nowhere to go.
    expect(row.failureReason).toMatch(/INSUFFICIENT_PERMISSIONS/);
    expect(row.failureReason).toMatch(/not an admin of that group/i);

    // Force the retry to be due now instead of waiting out the real backoff delay.
    await prisma.groupParticipantAddItem.update({ where: { id: row.id }, data: { scheduledAt: new Date() } });
    await processOne(provider); // attempt 2 -> exhausted -> FAILED
    row = await prisma.groupParticipantAddItem.findFirstOrThrow({ where: { jobId: job.id } });
    expect(row.status).toBe("FAILED");
    expect(row.attemptCount).toBe(2);

    const refreshedJob = await prisma.groupParticipantAddJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(refreshedJob.status).toBe("COMPLETED"); // no items left PENDING/PROCESSING
  });

  it("marks FAILED when the provider throws, not just when it returns success:false", async () => {
    await resetAddSettings({ retryMaxAttempts: 1 });
    const group = await makeGroup();
    const job = await makeJob({ queuedCount: 1, totalRequested: 1, retryMaxAttempts: 1 });
    await queueItem({ job, group });

    const provider = new MockProvider();
    provider.addGroupParticipant = async () => {
      throw new Error("simulated network error");
    };

    await processOne(provider);
    const row = await prisma.groupParticipantAddItem.findFirstOrThrow({ where: { jobId: job.id } });
    expect(row.status).toBe("FAILED");
    expect(row.failureReason).toMatch(/simulated network error/);
  });
});

describe("Scenario 4: kill switch stops a running job", () => {
  it("cancels the pending item and stamps the job STOPPED_KILL_SWITCH", async () => {
    const group = await makeGroup();
    const job = await makeJob({ queuedCount: 1, totalRequested: 1 });
    await queueItem({ job, group });
    await resetAutomationSettings({ automationEnabled: false });

    const provider = new MockProvider();
    await processOne(provider);

    const row = await prisma.groupParticipantAddItem.findFirstOrThrow({ where: { jobId: job.id } });
    expect(row.status).toBe("CANCELLED");
    expect(provider.addedParticipants).toHaveLength(0);

    const refreshedJob = await prisma.groupParticipantAddJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(refreshedJob.status).toBe("STOPPED_KILL_SWITCH");
  });

  it("cancels an item belonging to an explicitly stopped job even while automation stays enabled", async () => {
    const group = await makeGroup();
    const job = await makeJob({ queuedCount: 1, totalRequested: 1, status: "CANCELLED", cancelledAt: new Date() });
    await queueItem({ job, group });

    const provider = new MockProvider();
    await processOne(provider);

    const row = await prisma.groupParticipantAddItem.findFirstOrThrow({ where: { jobId: job.id } });
    expect(row.status).toBe("CANCELLED");
    expect(provider.addedParticipants).toHaveLength(0);
  });
});

describe("Scenario 5: worker restart -> crash recovery, no duplicate add", () => {
  it("requeues a stuck PROCESSING item to PENDING without creating a duplicate", async () => {
    const group = await makeGroup();
    const job = await makeJob({ queuedCount: 1, totalRequested: 1 });
    const item = await queueItem({ job, group });
    await prisma.groupParticipantAddItem.update({ where: { id: item.id }, data: { status: "PROCESSING" } });
    await prisma.$executeRaw`UPDATE "GroupParticipantAddItem" SET "updatedAt" = NOW() - INTERVAL '10 minutes' WHERE id = ${item.id}`;

    const recovered = await recoverStuckParticipantAddItems();
    expect(recovered).toBeGreaterThanOrEqual(1);

    const row = await prisma.groupParticipantAddItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(row.status).toBe("PENDING");
    expect(await prisma.groupParticipantAddItem.count({ where: { jobId: job.id } })).toBe(1);

    const provider = new MockProvider();
    await processOne(provider);
    expect((await prisma.groupParticipantAddItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe("ADDED");
  });
});

describe("Scenario 6: duplicate-queue prevention", () => {
  it("rejects a second item for the same (job, group) pair via the unique constraint", async () => {
    const group = await makeGroup();
    const job = await makeJob({ queuedCount: 1, totalRequested: 1 });
    await queueItem({ job, group });

    await expect(queueItem({ job, group })).rejects.toMatchObject({ code: "P2002" });
    expect(await prisma.groupParticipantAddItem.count({ where: { jobId: job.id } })).toBe(1);
  });
});

describe("Membership verification (safety requirement: never act blindly)", () => {
  it("marks the item FAILED, not added, when the provider reports the account is no longer a member", async () => {
    const group = await makeGroup();
    const job = await makeJob({ queuedCount: 1, totalRequested: 1 });
    await queueItem({ job, group });

    const provider = new MockProvider();
    provider.defaultMembership = false;
    await processOne(provider);

    const row = await prisma.groupParticipantAddItem.findFirstOrThrow({ where: { jobId: job.id } });
    expect(row.status).toBe("FAILED");
    expect(row.failureReason).toMatch(/Membership could not be verified/);
    expect(provider.addedParticipants).toHaveLength(0);
  });
});

describe("Already a member: skipped rather than attempted", () => {
  it("skips without calling addParticipant when the number is already in the group", async () => {
    // A rejected add is a signal WhatsApp counts against the number. Re-running a roster across
    // groups it is partly already in would generate hundreds of them, which is the opposite of
    // what this feature's pacing exists to avoid.
    const group = await makeGroup();
    const job = await makeJob();
    const item = await queueItem({ job, group, phoneNumber: "8801000000000" });

    const provider = new MockProvider();
    provider.participantsByChatId.set(group.whatsappGroupId, [
      { phoneNumber: "8801000000000", name: "Already In", isSelf: false },
    ]);

    await processOne(provider);

    const refreshed = await prisma.groupParticipantAddItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(refreshed.status).toBe("SKIPPED_ALREADY_MEMBER");
    expect(provider.addedParticipants).toHaveLength(0);
  });

  it("matches on digits, not on formatting", async () => {
    const group = await makeGroup();
    const job = await makeJob();
    const item = await queueItem({ job, group, phoneNumber: "8801000000000" });

    const provider = new MockProvider();
    provider.participantsByChatId.set(group.whatsappGroupId, [
      { phoneNumber: "+880 1000000000", name: "Same Person", isSelf: false },
    ]);

    await processOne(provider);

    expect(
      (await prisma.groupParticipantAddItem.findUniqueOrThrow({ where: { id: item.id } })).status,
    ).toBe("SKIPPED_ALREADY_MEMBER");
    expect(provider.addedParticipants).toHaveLength(0);
  });

  it("still attempts the add when the participant list comes back empty", async () => {
    // An empty list means "could not read", not "nobody is in this group" — the provider may be
    // mid-reconnect. Reading it as "already in" would silently skip every remaining group and
    // report the job complete, so doubt has to fall on the side of attempting.
    const group = await makeGroup();
    const job = await makeJob();
    const item = await queueItem({ job, group, phoneNumber: "8801000000000" });

    const provider = new MockProvider();

    await processOne(provider);

    expect((await prisma.groupParticipantAddItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe("ADDED");
    expect(provider.addedParticipants).toHaveLength(1);
  });

  it("adds a number that is not among the existing participants", async () => {
    const group = await makeGroup();
    const job = await makeJob();
    await queueItem({ job, group, phoneNumber: "8801000000000" });

    const provider = new MockProvider();
    provider.participantsByChatId.set(group.whatsappGroupId, [
      { phoneNumber: "8809999999999", name: "Somebody Else", isSelf: false },
    ]);

    await processOne(provider);

    expect(provider.addedParticipants).toEqual([
      { chatId: group.whatsappGroupId, phoneNumber: "8801000000000" },
    ]);
  });
});

describe("Several numbers in one job", () => {
  it("adds each number using its own item, not the job's first", async () => {
    // The bug this pins is the obvious one after moving the number onto the item: reading it back
    // off the job would add the same person twice and never touch the second.
    const group = await makeGroup();
    const job = await makeJob({ phoneNumbers: ["8801000000000", "8802000000000"] });
    await queueItem({ job, group, phoneNumber: "8801000000000" });
    await queueItem({ job, group, phoneNumber: "8802000000000" });

    const provider = new MockProvider();
    await processOne(provider);
    await processOne(provider);

    expect(provider.addedParticipants.map((a) => a.phoneNumber).sort()).toEqual([
      "8801000000000",
      "8802000000000",
    ]);
  });

  it("lets the same group appear once per number", async () => {
    // Idempotency is (job, group, number) now. If it were still (job, group), the second person
    // could not be queued for a group the first was already queued for.
    const group = await makeGroup();
    const job = await makeJob({ phoneNumbers: ["8801000000000", "8802000000000"] });
    await queueItem({ job, group, phoneNumber: "8801000000000" });
    await queueItem({ job, group, phoneNumber: "8802000000000" });

    expect(await prisma.groupParticipantAddItem.count({ where: { jobId: job.id } })).toBe(2);
  });

  it("completes the job only once every number has been processed everywhere", async () => {
    const group = await makeGroup();
    const job = await makeJob({ phoneNumbers: ["8801000000000", "8802000000000"] });
    await queueItem({ job, group, phoneNumber: "8801000000000" });
    await queueItem({ job, group, phoneNumber: "8802000000000" });

    const provider = new MockProvider();
    await processOne(provider);
    expect((await prisma.groupParticipantAddJob.findUniqueOrThrow({ where: { id: job.id } })).status).not.toBe(
      "COMPLETED",
    );

    await processOne(provider);
    expect((await prisma.groupParticipantAddJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe(
      "COMPLETED",
    );
  });
});

describe("The per-minute cap is global, not per job", () => {
  it("holds a second job back because of a first job's adds", async () => {
    // The whole reason the size cap could be raised. When this was per-job, splitting a large
    // selection into twenty jobs ran at twenty times the configured rate on the operation
    // WhatsApp punishes hardest — the cap manufactured the risk it looked like it prevented.
    const groupA = await makeGroup();
    const groupB = await makeGroup();
    const jobA = await makeJob({ maxPerMinute: 1 });
    const jobB = await makeJob({ maxPerMinute: 1 });
    await queueItem({ job: jobA, group: groupA });
    const itemB = await queueItem({ job: jobB, group: groupB });

    const provider = new MockProvider();
    await processOne(provider); // consumes the single add allowed this minute
    await processOne(provider); // jobB's item must be deferred, not added

    const refreshedB = await prisma.groupParticipantAddItem.findUniqueOrThrow({ where: { id: itemB.id } });
    expect(refreshedB.status).toBe("PENDING");
    expect(refreshedB.scheduledAt.getTime()).toBeGreaterThan(Date.now());
    expect(provider.addedParticipants).toHaveLength(1);
  });

  it("counts a skip against the budget too", async () => {
    // Establishing that somebody is already in a group is itself a call to WhatsApp. Pacing only
    // successful adds would let a large re-run hammer the API at full speed while reporting that
    // it barely did anything.
    const groupA = await makeGroup();
    const groupB = await makeGroup();
    const job = await makeJob({ maxPerMinute: 1 });
    await queueItem({ job, group: groupA, phoneNumber: "8801000000000" });
    const itemB = await queueItem({ job, group: groupB, phoneNumber: "8801000000000" });

    const provider = new MockProvider();
    provider.participantsByChatId.set(groupA.whatsappGroupId, [
      { phoneNumber: "8801000000000", name: "Already In", isSelf: false },
    ]);

    await processOne(provider); // skips groupA — still spends the minute's budget
    await processOne(provider);

    expect((await prisma.groupParticipantAddItem.findUniqueOrThrow({ where: { id: itemB.id } })).status).toBe(
      "PENDING",
    );
  });
});
