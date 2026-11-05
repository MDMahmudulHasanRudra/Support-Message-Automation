import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import { databaseFigures, serverFigures, speedFigures } from "@/server/platform/systemFigures";

/**
 * Platform → Monitoring's figures against a real Postgres (P1-08, doc 20 O5–O7). The SQL is what is under
 * test: GROUPING SETS, percentile casts, the enum comparison, the statement timeout inside a transaction,
 * and the catalog views.
 *
 * This project's messages are stored 10 to 13 minutes after WhatsApp's time — slower than anything another
 * test seeds — so it is the slowest project and its own figures can be asserted exactly, whatever else the
 * shared test database holds.
 */

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const NOW = new Date();
let projectId: string;
let accountId: string;
let creatorId: string;
let hadProcessRow = false;

beforeAll(async () => {
  creatorId = (await rawPrisma.user.create({ data: { username: `sysfig_${tag}`, email: `sysfig_${tag}@example.test`, name: "Sysfig", passwordHash: "x" } })).id;
  const created = await createProjectWithDefaults({ name: `Sysfig ${tag}`, slug: `sysfig-${tag}`, status: "ACTIVE", creatorUserId: creatorId }, rawPrisma);
  projectId = created.id;
  accountId = (await rawPrisma.whatsAppAccount.create({ data: { projectId, label: `Sysfig number ${tag}` } })).id;
  const delaysSeconds = [600, 660, 720, 780];
  for (const delay of delaysSeconds) {
    const sentAt = new Date(NOW.getTime() - 60 * 60_000);
    await rawPrisma.message.create({
      data: {
        projectId,
        accountId,
        chatId: `8801711${tag.slice(0, 6).replace(/\D/g, "0")}@c.us`,
        whatsappMessageId: `wamid-${randomUUID()}`,
        senderPhone: "8801711000444",
        direction: "INCOMING",
        body: "x",
        normalizedBody: "x",
        timestampWa: sentAt,
        createdAt: new Date(sentAt.getTime() + delay * 1000),
      },
    });
  }
  hadProcessRow = Boolean(await rawPrisma.workerHealthSnapshot.findUnique({ where: { id: "process" } }));
});

afterAll(async () => {
  await rawPrisma.message.deleteMany({ where: { projectId } });
  await rawPrisma.whatsAppAccount.deleteMany({ where: { projectId } });
  const tables = (
    await rawPrisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`
  ).map((row) => row.table_name);
  for (let pass = 0; pass < 4; pass++) {
    for (const table of tables) await rawPrisma.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "projectId" = $1`, projectId).catch(() => undefined);
  }
  await rawPrisma.project.deleteMany({ where: { id: projectId } });
  await rawPrisma.user.deleteMany({ where: { id: creatorId } });
  if (!hadProcessRow) await rawPrisma.workerHealthSnapshot.deleteMany({ where: { id: "process" } });
  await rawPrisma.$disconnect();
});

describe("speedFigures", () => {
  it("computes per-project storing time with percentiles, and names the slowest project", async () => {
    const speed = await speedFigures(NOW);
    const mine = speed.slowestProjects.find((p) => p.projectId === projectId);
    expect(mine).toBeDefined();
    expect(mine!.name).toBe(`Sysfig ${tag}`);
    expect(mine!.count).toBe(4);
    // percentile_cont(0.95) over 600, 660, 720, 780 = 771
    expect(mine!.p95).toBeCloseTo(771, 3);
    expect(speed.slowestProjects[0]!.projectId).toBe(projectId);
    // The total row (GROUPING SETS ()) covers at least this project's four.
    expect(speed.inbound.count).toBeGreaterThanOrEqual(4);
    expect(speed.outbound.count).toBeGreaterThanOrEqual(0);
    expect(speed.queues.map((q) => q.name)).toEqual(["WhatsApp sends", "Alerts", "Worker commands", "Channel replies", "Email", "Social posts"]);
  });

  it("leaves out a message stored after more than 15 minutes (a catch-up, not the live path)", async () => {
    const sentAt = new Date(NOW.getTime() - 2 * 60 * 60_000);
    await rawPrisma.message.create({
      data: {
        projectId,
        accountId,
        chatId: "x@c.us",
        whatsappMessageId: `wamid-${randomUUID()}`,
        senderPhone: "8801711000445",
        direction: "INCOMING",
        body: "late",
        normalizedBody: "late",
        timestampWa: sentAt,
        createdAt: new Date(sentAt.getTime() + 30 * 60_000),
      },
    });
    const mine = (await speedFigures(NOW)).slowestProjects.find((p) => p.projectId === projectId);
    expect(mine!.count).toBe(4);
  });
});

describe("databaseFigures", () => {
  it("reads connections, size, the largest tables and the cache from Postgres's own views", async () => {
    const db = await databaseFigures();
    expect(db.connections.max).toBeGreaterThan(0);
    expect(db.connections.total).toBeGreaterThanOrEqual(1);
    expect(db.sizeBytes).toBeGreaterThan(0);
    expect(db.largestTables.length).toBeGreaterThan(0);
    expect(db.largestTables[0]!.bytes).toBeGreaterThan(0);
    if (db.cacheHitRatio !== null) {
      expect(db.cacheHitRatio).toBeGreaterThan(0);
      expect(db.cacheHitRatio).toBeLessThanOrEqual(1);
    }
  });
});

describe("serverFigures", () => {
  it("reads the worker's 'process' snapshot row and labels its browsers, without touching the 'global' row", async () => {
    const before = await rawPrisma.workerHealthSnapshot.findUnique({ where: { id: "global" } });
    const reading = {
      at: NOW.toISOString(),
      worker: { rssMb: 250, heapUsedMb: 100, heapTotalMb: 180, eventLoopP50Ms: 10, eventLoopP99Ms: 30, uptimeMinutes: 5 },
      host: { cpus: 4, load1PerCpu: 0.5, totalMemMb: 16_000, freeMemMb: 9_000 },
      container: { memoryUsedMb: 2_000, memoryLimitMb: null },
      browsers: [{ accountId, processes: 8, memoryMb: 640 }],
      disks: [{ name: "media", freeMb: 50_000, totalMb: 80_000 }],
    };
    await rawPrisma.workerHealthSnapshot.upsert({
      where: { id: "process" },
      update: { loops: reading, startedAt: NOW },
      create: { id: "process", loops: reading, startedAt: NOW },
    });
    const figures = await serverFigures(NOW);
    expect(figures.stats?.browsers).toEqual(reading.browsers);
    expect(figures.accountLabels[accountId]).toBe(`Sysfig number ${tag}`);
    expect(figures.stale).toBe(false);
    expect(figures.warnings).toEqual([]);
    expect(await rawPrisma.workerHealthSnapshot.findUnique({ where: { id: "global" } })).toEqual(before);
  });
});
