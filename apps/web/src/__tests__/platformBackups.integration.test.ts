import "./helpers/requireTestDatabase";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma as rawPrisma } from "@support-automation/db";
import { backupFigures } from "@/server/platform/backups";

/** Platform → Overview's Backups section: the recorded runs, read the way the worker's alert reads them. */

const NOW = new Date();
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const run = (status: "SUCCEEDED" | "FAILED", finishedAt: Date, extra: { reason?: string; databaseBytes?: bigint } = {}) =>
  rawPrisma.backupRun.create({ data: { status, startedAt: new Date(finishedAt.getTime() - 60_000), finishedAt, ...extra } });

beforeEach(async () => {
  await rawPrisma.backupAlert.deleteMany({});
  await rawPrisma.backupRun.deleteMany({});
});
afterAll(async () => {
  await rawPrisma.backupAlert.deleteMany({});
  await rawPrisma.backupRun.deleteMany({});
  await rawPrisma.$disconnect();
});

describe("backupFigures", () => {
  it("reports NONE before any run", async () => {
    expect((await backupFigures(NOW)).state).toBe("NONE");
  });

  it("reports the last success with its size, the week's counts, and a failure reason without any path", async () => {
    await run("SUCCEEDED", hoursAgo(10), { databaseBytes: 2048n });
    await run("FAILED", hoursAgo(1), { reason: "pg_dump could not write /home/rudra/backups/db/x.dump.part" });
    const figures = await backupFigures(NOW);
    expect(figures.state).toBe("FAILED");
    expect(figures.lastSuccessDatabaseBytes).toBe(2048);
    expect(figures.runsLast7Days).toEqual({ succeeded: 1, failed: 1 });
    expect(figures.latest?.reason).toBe("pg_dump could not write [path]");
  });

  it("reports STALE when the last success is older than the threshold", async () => {
    await run("SUCCEEDED", hoursAgo(40));
    expect((await backupFigures(NOW)).state).toBe("STALE");
  });
});
