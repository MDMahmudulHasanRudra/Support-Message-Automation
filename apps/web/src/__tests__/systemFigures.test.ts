import { describe, expect, it } from "vitest";
import { databaseWarnings, serverWarnings, speedWarnings, THRESHOLDS, type DatabaseFigures, type ServerStats, type SpeedFigures } from "@/server/platform/systemFigures";

/**
 * The plain-language findings on Platform → Monitoring (P1-08, doc 20 O5–O7). Pure: figures in, sentences out.
 * Thresholds are starting values (THRESHOLDS), so the tests sit just either side of them rather than
 * restating their numbers.
 */

const NOW = new Date("2026-11-05T12:00:00Z");

function healthy(): ServerStats {
  return {
    at: new Date(NOW.getTime() - 30_000).toISOString(),
    worker: { rssMb: 300, heapUsedMb: 120, heapTotalMb: 200, eventLoopP50Ms: 11, eventLoopP99Ms: 40, uptimeMinutes: 600 },
    host: { cpus: 4, load1PerCpu: 0.6, totalMemMb: 16_000, freeMemMb: 6_000 },
    container: { memoryUsedMb: 3_000, memoryLimitMb: null },
    browsers: [{ accountId: "acc-1", processes: 9, memoryMb: 700 }],
    disks: [{ name: "media", freeMb: 40_000, totalMb: 80_000 }],
  };
}

describe("serverWarnings", () => {
  it("says nothing about a healthy server", () => {
    expect(serverWarnings(healthy(), NOW)).toEqual([]);
  });

  it("says when the worker has published nothing yet", () => {
    expect(serverWarnings(null, NOW)).toEqual(["The worker has not published server figures yet (it does once a minute)."]);
  });

  it("flags stale figures, low disk, a slow event loop, memory pressure, load and big or orphaned browsers", () => {
    const s = healthy();
    s.at = new Date(NOW.getTime() - THRESHOLDS.staleAfterMs - 60_000).toISOString();
    s.disks = [{ name: "media", freeMb: 5_000, totalMb: 80_000 }];
    s.worker.eventLoopP99Ms = THRESHOLDS.eventLoopP99Ms + 1;
    s.container = { memoryUsedMb: 900, memoryLimitMb: 1_000 };
    s.host.freeMemMb = 800;
    s.host.load1PerCpu = THRESHOLDS.loadPerCpu + 0.1;
    s.browsers = [
      { accountId: "acc-1", processes: 12, memoryMb: THRESHOLDS.browserMb + 1 },
      { accountId: null, processes: 3, memoryMb: 210 },
    ];
    const out = serverWarnings(s, NOW, { "acc-1": "Primary number" });
    expect(out).toHaveLength(8);
    expect(out.join("\n")).toMatch(/minutes old/);
    expect(out.join("\n")).toMatch(/Disk \(media\): only 6% free/);
    expect(out.join("\n")).toMatch(/The browser for Primary number uses 1501 MB/);
    expect(out.join("\n")).toMatch(/belongs to no account is running \(210 MB\)/);
  });

  it("does not invent a problem from a figure it could not read", () => {
    const s = healthy();
    s.worker.eventLoopP99Ms = null;
    s.host.load1PerCpu = null;
    s.container = { memoryUsedMb: null, memoryLimitMb: null };
    s.disks = [];
    expect(serverWarnings(s, NOW)).toEqual([]);
  });
});

describe("speedWarnings", () => {
  const speed = (p95: number | null, oldest: number | null): SpeedFigures => ({
    inbound: { count: 100, p50: 2, p95, p99: null },
    slowestProjects: [],
    outbound: { count: 0, p50: null, p95: null, p99: null },
    queues: [{ name: "WhatsApp sends", waiting: 1, oldestWaitingSeconds: oldest, failed24h: 0 }],
  });

  it("flags slow storing and a queue that is not moving, and nothing else", () => {
    expect(speedWarnings(speed(5, 30))).toEqual([]);
    expect(speedWarnings(speed(THRESHOLDS.inboundP95Seconds + 10, THRESHOLDS.oldestWaitingSeconds + 120))).toEqual([
      "Incoming messages take 130 s to be stored (p95, 24 h).",
      "WhatsApp sends: the oldest due item has waited 12 minutes.",
    ]);
  });
});

describe("databaseWarnings", () => {
  const db = (over: Partial<DatabaseFigures> = {}): DatabaseFigures => ({
    connections: { byState: [{ state: "idle", count: 12 }], total: 12, max: 100 },
    sizeBytes: 1e9,
    oldestActiveQuerySeconds: null,
    idleInTransaction: { count: 0, oldestSeconds: null },
    cacheHitRatio: 0.999,
    largestTables: [],
    ...over,
  });

  it("says nothing about a healthy database", () => {
    expect(databaseWarnings(db())).toEqual([]);
  });

  it("flags connection pressure, a long query, an abandoned transaction and a cold cache", () => {
    const out = databaseWarnings(
      db({
        connections: { byState: [], total: 85, max: 100 },
        oldestActiveQuerySeconds: 90,
        idleInTransaction: { count: 2, oldestSeconds: 300 },
        cacheHitRatio: 0.9,
      }),
    );
    expect(out).toEqual([
      "Database connections: 85 of 100 in use.",
      "A database query has been running for 90 s.",
      "2 connection(s) idle inside a transaction, the oldest for 300 s.",
      "Database cache hit ratio 90.0%: memory may be too small for the data read.",
    ]);
  });
});
