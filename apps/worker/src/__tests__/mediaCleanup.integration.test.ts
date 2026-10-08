import "./helpers/requireTestDatabase.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MediaStorageSettings, User, WhatsAppAccount, WhatsAppGroup } from "@prisma/client";
import { createProjectWithDefaults } from "@support-automation/db";
import { buildMediaStorageKey, LocalMediaStorage, type MediaStorage } from "@support-automation/media-storage";
import { inIsp, prisma, rawPrisma, ISP_DIGITAL } from "./helpers/projectFixtures.js";
import { resetProjectCachesForTests, withProject } from "../project/context.js";
import { processOneCleanupBatch, runCleanupBatch, scheduleRetentionCleanups } from "../media/mediaCleanupProcessor.js";

/**
 * Media retention and cleanup (MEDIA_STORAGE.md): stored FILES older than a date are removed in
 * batches; the messages they belonged to are never touched.
 */

const DAY = 24 * 60 * 60_000;
let account: WhatsAppAccount;
let group: WhatsAppGroup;
let root: string;
let storage: LocalMediaStorage;
let savedSettings: MediaStorageSettings | null;
let creator: User;

/** One message with a STORED file, created `ageDays` ago. */
async function storedMedia(ageDays: number, opts: { projectAccount?: WhatsAppAccount; projectGroup?: WhatsAppGroup } = {}) {
  const acc = opts.projectAccount ?? account;
  const grp = opts.projectGroup ?? group;
  const createdAt = new Date(Date.now() - ageDays * DAY);
  const message = await prisma.message.create({
    data: {
      accountId: acc.id,
      groupId: grp.id,
      whatsappMessageId: randomUUID(),
      chatId: grp.whatsappGroupId,
      senderPhone: "8801700000002",
      direction: "INCOMING",
      body: `[Image] photo from ${ageDays} days ago`,
      normalizedBody: `[Image] photo from ${ageDays} days ago`,
      timestampWa: createdAt,
      processingStatus: "PROCESSED",
    },
  });
  const media = await prisma.messageMedia.create({
    data: { messageId: message.id, accountId: acc.id, groupId: grp.id, mediaType: "IMAGE", waType: "image", mimeType: "image/jpeg", status: "PENDING", createdAt },
  });
  const storageKey = buildMediaStorageKey({ projectId: media.projectId, accountId: acc.id, groupId: grp.id, mediaId: media.id, createdAt });
  const bytes = randomBytes(1000 + Math.floor(Math.random() * 1000));
  await storage.put(storageKey, bytes);
  await prisma.messageMedia.update({ where: { id: media.id }, data: { status: "STORED", storageKey, sizeBytes: BigInt(bytes.length), storedAt: createdAt } });
  return { message, mediaId: media.id, storageKey, size: bytes.length };
}

async function runJob(jobId: string, s: MediaStorage = storage, batchSize = 3) {
  for (let i = 0; i < 100; i++) {
    await inIsp(() => runCleanupBatch(jobId, s, batchSize));
    const job = await prisma.mediaCleanupJob.findUniqueOrThrow({ where: { id: jobId } });
    if (!["SCHEDULED", "RUNNING"].includes(job.status)) return job;
  }
  throw new Error("cleanup did not finish");
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "media-cleanup-"));
  storage = new LocalMediaStorage(root);
  savedSettings = await prisma.mediaStorageSettings.findUnique({ where: { id: "global" } });
  creator = await rawPrisma.user.create({ data: { username: `cleanup-${randomUUID().slice(0, 8)}`, email: `${randomUUID()}@example.test`, name: "c", passwordHash: "x" } });
});

beforeEach(async () => {
  resetProjectCachesForTests();
  // Earlier suites' jobs must not be picked up first by the cross-project claim.
  await rawPrisma.mediaCleanupJob.updateMany({ where: { status: { in: ["SCHEDULED", "RUNNING"] } }, data: { status: "CANCELLED" } });
  account = await prisma.whatsAppAccount.create({ data: { label: `Cleanup ${randomUUID()}`, status: "CONNECTED" } });
  group = await prisma.whatsAppGroup.create({ data: { accountId: account.id, whatsappGroupId: `cleanup-${randomUUID().slice(0, 8)}@g.us`, name: "Cleanup group", isActive: true } });
  await prisma.mediaStorageSettings.update({ where: { id: "global" }, data: { retentionDays: null } });
});

afterEach(async () => {
  await rawPrisma.mediaCleanupJob.deleteMany({ where: { projectId: ISP_DIGITAL } });
  await rawPrisma.whatsAppAccount.deleteMany({ where: { id: account.id } });
});

afterAll(async () => {
  if (savedSettings) await prisma.mediaStorageSettings.update({ where: { id: "global" }, data: { retentionDays: savedSettings.retentionDays } });
  await rm(root, { recursive: true, force: true });
  await rawPrisma.$disconnect();
});

describe("a cleanup removes old files and never a message", () => {
  it("removes every stored file older than the date, in batches, and keeps every message", async () => {
    const old = await Promise.all([200, 150, 120, 100, 95, 91, 400].map((d) => storedMedia(d)));
    const recent = await Promise.all([10, 60, 89].map((d) => storedMedia(d)));
    const messageCount = await prisma.message.count({ where: { accountId: account.id } });

    const job = await prisma.mediaCleanupJob.create({ data: { trigger: "MANUAL", olderThan: new Date(Date.now() - 90 * DAY), requestedById: creator.id } });
    const done = await runJob(job.id);

    expect(done).toMatchObject({ status: "COMPLETED", totalCandidates: 7, processedCount: 7, deletedCount: 7, failedCount: 0, lastError: null });
    expect(Number(done.freedBytes)).toBe(old.reduce((sum, m) => sum + m.size, 0));
    for (const m of old) {
      expect(await storage.exists(m.storageKey)).toBe(false);
      expect(await prisma.messageMedia.findUniqueOrThrow({ where: { id: m.mediaId } })).toMatchObject({ status: "DELETED", statusReason: "MANUAL_CLEANUP" });
    }
    for (const m of recent) {
      expect(await storage.exists(m.storageKey)).toBe(true);
      expect((await prisma.messageMedia.findUniqueOrThrow({ where: { id: m.mediaId } })).status).toBe("STORED");
    }
    // The text history is all still there, word for word.
    expect(await prisma.message.count({ where: { accountId: account.id } })).toBe(messageCount);
    for (const m of old) {
      expect((await prisma.message.findUniqueOrThrow({ where: { id: m.message.id } })).body).toBe(m.message.body);
    }
  });

  it("a file that cannot be removed is kept STORED and counted, never reported as deleted — and a later run removes it", async () => {
    const files = await Promise.all([120, 110, 100].map((d) => storedMedia(d)));
    const stuck = files[1]!;
    const flaky: MediaStorage = {
      ...storage,
      driver: "local",
      put: storage.put.bind(storage),
      get: storage.get.bind(storage),
      stat: storage.stat.bind(storage),
      exists: storage.exists.bind(storage),
      freeBytes: storage.freeBytes.bind(storage),
      delete: async (key) => {
        if (key === stuck.storageKey) throw new Error("EBUSY: resource busy");
        return storage.delete(key);
      },
    };
    const job = await prisma.mediaCleanupJob.create({ data: { trigger: "MANUAL", olderThan: new Date(Date.now() - 90 * DAY) } });
    const done = await runJob(job.id, flaky);
    expect(done).toMatchObject({ status: "COMPLETED", deletedCount: 2, failedCount: 1 });
    expect(done.lastError).toMatch(/1 file\(s\) could not be removed/);
    expect((await prisma.messageMedia.findUniqueOrThrow({ where: { id: stuck.mediaId } })).status).toBe("STORED");
    expect(await storage.exists(stuck.storageKey)).toBe(true);

    const again = await prisma.mediaCleanupJob.create({ data: { trigger: "MANUAL", olderThan: new Date(Date.now() - 90 * DAY) } });
    expect(await runJob(again.id)).toMatchObject({ status: "COMPLETED", deletedCount: 1, failedCount: 0 });
    expect(await storage.exists(stuck.storageKey)).toBe(false);
  });

  it("carries on from where it stopped after a restart, without removing anything twice", async () => {
    await Promise.all([300, 250, 200, 150, 120].map((d) => storedMedia(d)));
    const job = await prisma.mediaCleanupJob.create({ data: { trigger: "MANUAL", olderThan: new Date(Date.now() - 90 * DAY) } });
    await inIsp(() => runCleanupBatch(job.id, storage, 2));
    const mid = await prisma.mediaCleanupJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(mid).toMatchObject({ status: "RUNNING", processedCount: 2, deletedCount: 2 });
    expect(mid.cursorId).not.toBeNull();
    // "Restart": the next process picks the same job up from its saved cursor.
    const done = await runJob(job.id, storage, 2);
    expect(done).toMatchObject({ status: "COMPLETED", processedCount: 5, deletedCount: 5 });
  });

  it("an empty run completes at once and says it removed nothing", async () => {
    await storedMedia(5);
    const job = await prisma.mediaCleanupJob.create({ data: { trigger: "MANUAL", olderThan: new Date(Date.now() - 90 * DAY) } });
    expect(await runJob(job.id)).toMatchObject({ status: "COMPLETED", totalCandidates: 0, deletedCount: 0 });
  });

  it("without storage configured the job fails visibly and nothing is marked deleted", async () => {
    const m = await storedMedia(200);
    const job = await prisma.mediaCleanupJob.create({ data: { trigger: "MANUAL", olderThan: new Date(Date.now() - 90 * DAY) } });
    await inIsp(() => runCleanupBatch(job.id, null));
    expect(await prisma.mediaCleanupJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: "FAILED" });
    expect((await prisma.messageMedia.findUniqueOrThrow({ where: { id: m.mediaId } })).status).toBe("STORED");
  });
});

describe("retention", () => {
  it("keep everything: nothing is ever scheduled, however old the files", async () => {
    await storedMedia(2000);
    await scheduleRetentionCleanups();
    expect(await prisma.mediaCleanupJob.count()).toBe(0);
  });

  it("3 months: a job is scheduled for files past it, removes only those, and is not rescheduled straight away", async () => {
    const old = await storedMedia(100);
    const young = await storedMedia(30);
    await prisma.mediaStorageSettings.update({ where: { id: "global" }, data: { retentionDays: 90 } });
    await scheduleRetentionCleanups();
    const job = await prisma.mediaCleanupJob.findFirstOrThrow({ where: { trigger: "RETENTION" } });
    expect(job.retentionDays).toBe(90);
    expect(Math.abs(job.olderThan.getTime() - (Date.now() - 90 * DAY))).toBeLessThan(60_000);

    await runJob(job.id);
    expect((await prisma.messageMedia.findUniqueOrThrow({ where: { id: old.mediaId } })).statusReason).toBe("RETENTION");
    expect((await prisma.messageMedia.findUniqueOrThrow({ where: { id: young.mediaId } })).status).toBe("STORED");

    await storedMedia(150);
    await scheduleRetentionCleanups();
    expect(await prisma.mediaCleanupJob.count({ where: { trigger: "RETENTION" } })).toBe(1);
  });

  it("changing retention stops a running retention job; switching to keep everything cancels a scheduled one", async () => {
    await Promise.all([200, 190, 180, 170].map((d) => storedMedia(d)));
    await prisma.mediaStorageSettings.update({ where: { id: "global" }, data: { retentionDays: 90 } });
    await scheduleRetentionCleanups();
    const job = await prisma.mediaCleanupJob.findFirstOrThrow({ where: { trigger: "RETENTION" } });
    await inIsp(() => runCleanupBatch(job.id, storage, 1));

    await prisma.mediaStorageSettings.update({ where: { id: "global" }, data: { retentionDays: 365 } });
    await inIsp(() => runCleanupBatch(job.id, storage, 1));
    const stopped = await prisma.mediaCleanupJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stopped).toMatchObject({ status: "CANCELLED", deletedCount: 1 });
    expect(await prisma.messageMedia.count({ where: { accountId: account.id, status: "STORED" } })).toBe(3);

    await prisma.mediaCleanupJob.deleteMany({});
    await prisma.mediaStorageSettings.update({ where: { id: "global" }, data: { retentionDays: 90 } });
    await scheduleRetentionCleanups();
    const scheduled = await prisma.mediaCleanupJob.findFirstOrThrow({ where: { trigger: "RETENTION", status: "SCHEDULED" } });
    await prisma.mediaStorageSettings.update({ where: { id: "global" }, data: { retentionDays: null } });
    await scheduleRetentionCleanups();
    expect((await prisma.mediaCleanupJob.findUniqueOrThrow({ where: { id: scheduled.id } })).status).toBe("CANCELLED");
    expect(await prisma.messageMedia.count({ where: { accountId: account.id, status: "STORED" } })).toBe(3);
  });
});

describe("project isolation", () => {
  it("one project's cleanup never removes another project's files", async () => {
    const other = await createProjectWithDefaults(
      { name: `Cleanup other ${randomUUID().slice(0, 6)}`, slug: `cleanup-other-${randomUUID().slice(0, 8)}`, status: "ACTIVE", creatorUserId: creator.id },
      rawPrisma,
    );
    const theirs = await withProject(other.id, async () => {
      const acc = await prisma.whatsAppAccount.create({ data: { label: "Other", status: "CONNECTED" } });
      const grp = await prisma.whatsAppGroup.create({ data: { accountId: acc.id, whatsappGroupId: `o-${randomUUID().slice(0, 8)}@g.us`, name: "Other", isActive: true } });
      return storedMedia(500, { projectAccount: acc, projectGroup: grp });
    });
    const mine = await storedMedia(500);

    await prisma.mediaCleanupJob.create({ data: { trigger: "MANUAL", olderThan: new Date(Date.now() - 90 * DAY) } });
    while (await processOneCleanupBatch(storage)) {
      /* run every active job to completion */
    }
    expect(await storage.exists(mine.storageKey)).toBe(false);
    expect(await storage.exists(theirs.storageKey)).toBe(true);
    expect((await rawPrisma.messageMedia.findUniqueOrThrow({ where: { id: theirs.mediaId } })).status).toBe("STORED");
  });
});
