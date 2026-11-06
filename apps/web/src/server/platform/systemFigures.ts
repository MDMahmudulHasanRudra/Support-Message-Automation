import { prisma as globalPrisma } from "@support-automation/db";

/**
 * Server, speed and database figures for Platform → Monitoring (P1-08, docs/get-assist-ultimate/20 O5–O7).
 *
 * Platform operators only (the page calls requireOperatorPage). Read with the unscoped client because the
 * server is shared by every customer. Every figure is a count, a duration, a size or an id: never a message,
 * a phone number or a query's text.
 *
 * The thresholds below are STARTING values, chosen to flag something worth a look, not measured limits of
 * this server. Adjust them after a week of real readings; never present them as capacity.
 */
export const THRESHOLDS = {
  /** Figures older than this mean the worker stopped publishing them. */
  staleAfterMs: 3 * 60_000,
  diskFreeFraction: 0.15,
  eventLoopP99Ms: 200,
  containerMemoryFraction: 0.85,
  hostFreeMemFraction: 0.1,
  browserMb: 1500,
  loadPerCpu: 1.5,
  inboundP95Seconds: 120,
  oldestWaitingSeconds: 10 * 60,
  connectionsFraction: 0.8,
  activeQuerySeconds: 60,
  idleInTransactionSeconds: 60,
  cacheHitRatio: 0.95,
} as const;

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

// ---------------------------------------------------------------------------------------------------------
// O5 — the worker's own reading (apps/worker/src/health/processStats.ts), published as snapshot row "process".

export interface ServerStats {
  at: string;
  worker: { rssMb: number; heapUsedMb: number; heapTotalMb: number; eventLoopP50Ms: number | null; eventLoopP99Ms: number | null; uptimeMinutes: number };
  host: { cpus: number; load1PerCpu: number | null; totalMemMb: number; freeMemMb: number };
  container: { memoryUsedMb: number | null; memoryLimitMb: number | null };
  browsers: Array<{ accountId: string | null; processes: number; memoryMb: number }>;
  disks: Array<{ name: string; freeMb: number; totalMb: number }>;
}

export interface ServerFigures {
  stats: ServerStats | null;
  stale: boolean;
  /** Account id → label, for the browsers table. */
  accountLabels: Record<string, string>;
  warnings: string[];
}

function isServerStats(value: unknown): value is ServerStats {
  const v = value as Partial<ServerStats> | null;
  return Boolean(v && typeof v === "object" && typeof v.at === "string" && v.worker && v.host && v.container && Array.isArray(v.browsers) && Array.isArray(v.disks));
}

/** Plain-language findings for one reading. Pure. */
export function serverWarnings(stats: ServerStats | null, now: Date, labels: Record<string, string> = {}): string[] {
  if (!stats) return ["The worker has not published server figures yet (it does once a minute)."];
  const out: string[] = [];
  const ageMs = now.getTime() - new Date(stats.at).getTime();
  if (ageMs > THRESHOLDS.staleAfterMs) out.push(`Server figures are ${Math.round(ageMs / MINUTE)} minutes old; the worker may have stopped.`);
  for (const d of stats.disks) {
    if (d.totalMb > 0 && d.freeMb / d.totalMb < THRESHOLDS.diskFreeFraction) out.push(`Disk (${d.name}): only ${Math.round((d.freeMb / d.totalMb) * 100)}% free.`);
  }
  if (stats.worker.eventLoopP99Ms !== null && stats.worker.eventLoopP99Ms > THRESHOLDS.eventLoopP99Ms) {
    out.push(`The worker is slow to respond: event-loop delay p99 ${stats.worker.eventLoopP99Ms} ms.`);
  }
  const { memoryUsedMb, memoryLimitMb } = stats.container;
  if (memoryUsedMb !== null && memoryLimitMb !== null && memoryUsedMb / memoryLimitMb > THRESHOLDS.containerMemoryFraction) {
    out.push(`The worker's container uses ${Math.round((memoryUsedMb / memoryLimitMb) * 100)}% of its memory limit.`);
  }
  if (stats.host.totalMemMb > 0 && stats.host.freeMemMb / stats.host.totalMemMb < THRESHOLDS.hostFreeMemFraction) {
    out.push(`The server has ${Math.round(stats.host.freeMemMb)} MB of memory free.`);
  }
  if (stats.host.load1PerCpu !== null && stats.host.load1PerCpu > THRESHOLDS.loadPerCpu) out.push(`The server is busy: load ${stats.host.load1PerCpu} per CPU.`);
  for (const b of stats.browsers) {
    if (b.accountId === null) out.push(`A WhatsApp browser that belongs to no account is running (${Math.round(b.memoryMb)} MB).`);
    else if (b.memoryMb > THRESHOLDS.browserMb) out.push(`The browser for ${labels[b.accountId] ?? "an account"} uses ${Math.round(b.memoryMb)} MB.`);
  }
  return out;
}

export async function serverFigures(now = new Date()): Promise<ServerFigures> {
  const row = await globalPrisma.workerHealthSnapshot.findUnique({ where: { id: "process" } });
  const reading: unknown = row?.loops;
  const stats = isServerStats(reading) ? reading : null;
  const ids = (stats?.browsers ?? []).map((b) => b.accountId).filter((id): id is string => id !== null);
  const accounts = ids.length ? await globalPrisma.whatsAppAccount.findMany({ where: { id: { in: ids } }, select: { id: true, label: true } }) : [];
  const accountLabels = Object.fromEntries(accounts.map((a) => [a.id, a.label]));
  return {
    stats,
    stale: !stats || now.getTime() - new Date(stats.at).getTime() > THRESHOLDS.staleAfterMs,
    accountLabels,
    warnings: serverWarnings(stats, now, accountLabels),
  };
}

// ---------------------------------------------------------------------------------------------------------
// O6 — speed, from rows that already exist. 24 hours, bounded by indexed time columns.

export interface Percentiles {
  count: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

export interface QueueFigure {
  name: string;
  waiting: number;
  /** Seconds the oldest row that is due has been waiting; null when nothing waits. */
  oldestWaitingSeconds: number | null;
  failed24h: number;
}

export interface SpeedFigures {
  /** WhatsApp time → stored, live path only (stored within 15 minutes), the baseline script's definition. */
  inbound: Percentiles;
  /** Projects with the slowest p95, worst first (at most 5). */
  slowestProjects: Array<{ projectId: string; name: string; p95: number; count: number }>;
  /** Due → sent for WhatsApp sends (scheduledAt includes the deliberate reply delay). */
  outbound: Percentiles;
  queues: QueueFigure[];
}

type PercentileRow = { projectId: string | null; n: bigint | number; p50: number | null; p95: number | null; p99?: number | null };

const toPercentiles = (row: PercentileRow | undefined): Percentiles => ({
  count: Number(row?.n ?? 0),
  p50: row?.p50 ?? null,
  p95: row?.p95 ?? null,
  p99: row?.p99 ?? null,
});

const secondsSince = (date: Date | null | undefined, now: Date) => (date ? Math.max(0, Math.round((now.getTime() - date.getTime()) / 1000)) : null);

export async function speedFigures(now = new Date()): Promise<SpeedFigures> {
  const since = new Date(now.getTime() - DAY);
  // One transaction so the statement timeout applies to both reads, and neither can hold the shared database.
  const [, inboundRows, outboundRows] = await globalPrisma.$transaction([
    globalPrisma.$executeRaw`SET LOCAL statement_timeout = '8s'`,
    globalPrisma.$queryRaw<PercentileRow[]>`
      SELECT m."projectId",
             count(*) AS n,
             percentile_cont(0.5)  WITHIN GROUP (ORDER BY extract(epoch FROM m."createdAt" - m."timestampWa"))::float AS p50,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM m."createdAt" - m."timestampWa"))::float AS p95,
             percentile_cont(0.99) WITHIN GROUP (ORDER BY extract(epoch FROM m."createdAt" - m."timestampWa"))::float AS p99
      FROM "Message" m
      WHERE m."timestampWa" >= ${since}
        AND m."direction" = 'INCOMING'
        AND m."createdAt" >= m."timestampWa"
        AND m."createdAt" - m."timestampWa" < interval '15 minutes'
      GROUP BY GROUPING SETS ((m."projectId"), ())`,
    globalPrisma.$queryRaw<PercentileRow[]>`
      SELECT o."projectId",
             count(*) AS n,
             percentile_cont(0.5)  WITHIN GROUP (ORDER BY extract(epoch FROM o."sentAt" - o."scheduledAt"))::float AS p50,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM o."sentAt" - o."scheduledAt"))::float AS p95
      FROM "OutboundMessage" o
      WHERE o."sentAt" >= ${since}
        AND o."status" = 'SENT'
        AND o."sentAt" >= o."scheduledAt"
      GROUP BY GROUPING SETS ((o."projectId"), ())`,
  ]);

  // GROUPING SETS: the row with no project is the total across all of them.
  const perProject = inboundRows.filter((r) => r.projectId !== null && r.p95 !== null).sort((a, b) => b.p95! - a.p95!).slice(0, 5);
  const names = perProject.length
    ? await globalPrisma.project.findMany({ where: { id: { in: perProject.map((r) => r.projectId!) } }, select: { id: true, name: true } })
    : [];
  const nameOf = new Map(names.map((p) => [p.id, p.name]));

  const due = { lte: now };
  const [outWaiting, outOldest, outFailed, notWaiting, notOldest, notFailed, cmdWaiting, cmdOldest, cmdFailed, chWaiting, chOldest, chFailed, emWaiting, emOldest, emFailed, soWaiting, soOldest, soFailed] =
    await Promise.all([
      globalPrisma.outboundMessage.count({ where: { status: { in: ["PENDING", "RATE_LIMITED"] }, scheduledAt: due } }),
      globalPrisma.outboundMessage.aggregate({ where: { status: { in: ["PENDING", "RATE_LIMITED"] }, scheduledAt: due }, _min: { scheduledAt: true } }),
      globalPrisma.outboundMessage.count({ where: { status: "FAILED", updatedAt: { gte: since } } }),
      globalPrisma.notification.count({ where: { status: { in: ["PENDING", "RETRYING"] } } }),
      globalPrisma.notification.aggregate({ where: { status: { in: ["PENDING", "RETRYING"] } }, _min: { createdAt: true } }),
      globalPrisma.notification.count({ where: { status: "FAILED", updatedAt: { gte: since } } }),
      globalPrisma.workerCommand.count({ where: { status: "PENDING" } }),
      globalPrisma.workerCommand.aggregate({ where: { status: "PENDING" }, _min: { createdAt: true } }),
      globalPrisma.workerCommand.count({ where: { status: "FAILED", createdAt: { gte: since } } }),
      globalPrisma.channelMessage.count({ where: { deliveryStatus: "QUEUED", OR: [{ nextAttemptAt: null }, { nextAttemptAt: due }] } }),
      globalPrisma.channelMessage.aggregate({ where: { deliveryStatus: "QUEUED", OR: [{ nextAttemptAt: null }, { nextAttemptAt: due }] }, _min: { createdAt: true } }),
      globalPrisma.channelMessage.count({ where: { deliveryStatus: { in: ["FAILED", "UNKNOWN"] }, createdAt: { gte: since } } }),
      globalPrisma.emailOutbox.count({ where: { status: "QUEUED", OR: [{ nextAttemptAt: null }, { nextAttemptAt: due }] } }),
      globalPrisma.emailOutbox.aggregate({ where: { status: "QUEUED", OR: [{ nextAttemptAt: null }, { nextAttemptAt: due }] }, _min: { createdAt: true } }),
      globalPrisma.emailOutbox.count({ where: { status: { in: ["FAILED", "UNKNOWN"] }, createdAt: { gte: since } } }),
      globalPrisma.socialPostTarget.count({ where: { status: "DUE", dueAt: due } }),
      globalPrisma.socialPostTarget.aggregate({ where: { status: "DUE", dueAt: due }, _min: { dueAt: true } }),
      globalPrisma.socialPostTarget.count({ where: { status: { in: ["FAILED", "UNKNOWN"] }, createdAt: { gte: since } } }),
    ]);

  return {
    inbound: toPercentiles(inboundRows.find((r) => r.projectId === null)),
    slowestProjects: perProject.map((r) => ({ projectId: r.projectId!, name: nameOf.get(r.projectId!) ?? r.projectId!, p95: r.p95!, count: Number(r.n) })),
    outbound: toPercentiles(outboundRows.find((r) => r.projectId === null)),
    queues: [
      { name: "WhatsApp sends", waiting: outWaiting, oldestWaitingSeconds: secondsSince(outOldest._min.scheduledAt, now), failed24h: outFailed },
      { name: "Alerts", waiting: notWaiting, oldestWaitingSeconds: secondsSince(notOldest._min.createdAt, now), failed24h: notFailed },
      { name: "Worker commands", waiting: cmdWaiting, oldestWaitingSeconds: secondsSince(cmdOldest._min.createdAt, now), failed24h: cmdFailed },
      { name: "Channel replies", waiting: chWaiting, oldestWaitingSeconds: secondsSince(chOldest._min.createdAt, now), failed24h: chFailed },
      { name: "Email", waiting: emWaiting, oldestWaitingSeconds: secondsSince(emOldest._min.createdAt, now), failed24h: emFailed },
      { name: "Social posts", waiting: soWaiting, oldestWaitingSeconds: secondsSince(soOldest._min.dueAt, now), failed24h: soFailed },
    ],
  };
}

/** Plain-language findings for the speed figures. Pure. */
export function speedWarnings(speed: SpeedFigures): string[] {
  const out: string[] = [];
  if (speed.inbound.p95 !== null && speed.inbound.p95 > THRESHOLDS.inboundP95Seconds) {
    out.push(`Incoming messages take ${Math.round(speed.inbound.p95)} s to be stored (p95, 24 h).`);
  }
  for (const q of speed.queues) {
    if (q.oldestWaitingSeconds !== null && q.oldestWaitingSeconds > THRESHOLDS.oldestWaitingSeconds) {
      out.push(`${q.name}: the oldest due item has waited ${Math.round(q.oldestWaitingSeconds / 60)} minutes.`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// O7 — the database, from Postgres's own statistics views. Read-only, no extension, no query text.

export interface DatabaseFigures {
  connections: { byState: Array<{ state: string; count: number }>; total: number; max: number };
  sizeBytes: number;
  /** Seconds the oldest running statement (other than this one) has been running; null when none. */
  oldestActiveQuerySeconds: number | null;
  idleInTransaction: { count: number; oldestSeconds: number | null };
  cacheHitRatio: number | null;
  largestTables: Array<{ name: string; bytes: number; rows: number }>;
}

export async function databaseFigures(): Promise<DatabaseFigures> {
  const [, states, settings, size, active, idle, tables, cache] = await globalPrisma.$transaction([
    globalPrisma.$executeRaw`SET LOCAL statement_timeout = '8s'`,
    globalPrisma.$queryRaw<Array<{ state: string; n: number }>>`
      SELECT coalesce(state, 'background') AS state, count(*)::int AS n
      FROM pg_stat_activity WHERE datname = current_database() GROUP BY 1 ORDER BY 2 DESC`,
    globalPrisma.$queryRaw<Array<{ max: number }>>`SELECT setting::int AS max FROM pg_settings WHERE name = 'max_connections'`,
    globalPrisma.$queryRaw<Array<{ bytes: bigint }>>`SELECT pg_database_size(current_database())::bigint AS bytes`,
    globalPrisma.$queryRaw<Array<{ seconds: number }>>`
      SELECT extract(epoch FROM now() - query_start)::float AS seconds
      FROM pg_stat_activity
      WHERE datname = current_database() AND state = 'active' AND pid <> pg_backend_pid() AND query_start IS NOT NULL
      ORDER BY query_start LIMIT 1`,
    globalPrisma.$queryRaw<Array<{ n: number; oldest: number | null }>>`
      SELECT count(*)::int AS n, max(extract(epoch FROM now() - xact_start))::float AS oldest
      FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction'`,
    globalPrisma.$queryRaw<Array<{ name: string; bytes: bigint; rows: bigint }>>`
      SELECT relname AS name, pg_total_relation_size(relid)::bigint AS bytes, n_live_tup::bigint AS rows
      FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 5`,
    globalPrisma.$queryRaw<Array<{ ratio: number | null }>>`
      SELECT CASE WHEN blks_hit + blks_read = 0 THEN NULL ELSE blks_hit::float / (blks_hit + blks_read) END AS ratio
      FROM pg_stat_database WHERE datname = current_database()`,
  ]);
  return {
    connections: { byState: states.map((s) => ({ state: s.state, count: s.n })), total: states.reduce((sum, s) => sum + s.n, 0), max: settings[0]?.max ?? 0 },
    sizeBytes: Number(size[0]?.bytes ?? 0),
    oldestActiveQuerySeconds: active[0] ? Math.round(active[0].seconds) : null,
    idleInTransaction: { count: idle[0]?.n ?? 0, oldestSeconds: idle[0]?.oldest != null ? Math.round(idle[0].oldest) : null },
    cacheHitRatio: cache[0]?.ratio ?? null,
    largestTables: tables.map((t) => ({ name: t.name, bytes: Number(t.bytes), rows: Number(t.rows) })),
  };
}

/** Plain-language findings for the database figures. Pure. */
export function databaseWarnings(db: DatabaseFigures): string[] {
  const out: string[] = [];
  if (db.connections.max > 0 && db.connections.total / db.connections.max > THRESHOLDS.connectionsFraction) {
    out.push(`Database connections: ${db.connections.total} of ${db.connections.max} in use.`);
  }
  if (db.oldestActiveQuerySeconds !== null && db.oldestActiveQuerySeconds > THRESHOLDS.activeQuerySeconds) {
    out.push(`A database query has been running for ${db.oldestActiveQuerySeconds} s.`);
  }
  if (db.idleInTransaction.oldestSeconds !== null && db.idleInTransaction.oldestSeconds > THRESHOLDS.idleInTransactionSeconds) {
    out.push(`${db.idleInTransaction.count} connection(s) idle inside a transaction, the oldest for ${db.idleInTransaction.oldestSeconds} s.`);
  }
  if (db.cacheHitRatio !== null && db.cacheHitRatio < THRESHOLDS.cacheHitRatio) {
    out.push(`Database cache hit ratio ${(db.cacheHitRatio * 100).toFixed(1)}%: memory may be too small for the data read.`);
  }
  return out;
}
