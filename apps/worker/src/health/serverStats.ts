import os from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { readdir, readFile, statfs } from "node:fs/promises";

/**
 * What this worker process and its browsers cost, for Platform → Monitoring (P1-08, doc 20 O5).
 *
 * Everything here is a figure about the machine — memory, load, delay, disk — and account ids. Never a
 * label, a phone number or anything a customer sent. Read on the heartbeat at most once a minute and
 * published as the `WorkerHealthSnapshot` row with id "process" (serverStatsPublisher.ts), beside the "global" row.
 *
 * A figure this platform cannot read is `null` ("unavailable"), never 0: `/proc` and cgroups exist only
 * on Linux, and a missing reading must not look like an idle machine.
 *
 * Not provider/openwa/processStats.ts, which asks a LIVE browser for its own CPU through OpenWA (for group
 * recovery). This reads /proc passively: it never calls into a browser, and it also sees browsers no client
 * holds any more (orphans).
 */

export interface ProcessStats {
  at: string;
  worker: { rssMb: number; heapUsedMb: number; heapTotalMb: number; eventLoopP50Ms: number | null; eventLoopP99Ms: number | null; uptimeMinutes: number };
  host: { cpus: number; load1PerCpu: number | null; totalMemMb: number; freeMemMb: number };
  /** This container's memory (the worker and every browser it started), from its cgroup. */
  container: { memoryUsedMb: number | null; memoryLimitMb: number | null };
  /** One entry per browser profile found running; accountId null = a browser no account owns (an orphan). */
  browsers: Array<{ accountId: string | null; processes: number; memoryMb: number }>;
  disks: Array<{ name: string; freeMb: number; totalMb: number }>;
}

const MB = 1024 * 1024;
const round = (n: number) => Math.round(n * 10) / 10;

// ---------------------------------------------------------------------------------------------------------
// Pure parsing — tested against fixture text.

/** `/proc/<pid>/status`: parent pid and resident memory (kB). */
export function parseProcStatus(text: string): { ppid: number | null; rssKb: number | null } {
  const ppid = text.match(/^PPid:\s+(\d+)/m)?.[1];
  const rss = text.match(/^VmRSS:\s+(\d+)\s+kB/m)?.[1];
  return { ppid: ppid ? Number(ppid) : null, rssKb: rss ? Number(rss) : null };
}

/** `/proc/<pid>/smaps_rollup`: proportional memory (kB), which does not count shared pages once per process. */
export function parsePssKb(text: string): number | null {
  const pss = text.match(/^Pss:\s+(\d+)\s+kB/m)?.[1];
  return pss ? Number(pss) : null;
}

export function userDataDir(argv: readonly string[]): string | null {
  const arg = argv.find((a) => a.startsWith("--user-data-dir="));
  return arg ? arg.slice("--user-data-dir=".length) : null;
}

export interface ProcRow {
  pid: number;
  ppid: number | null;
  memoryKb: number;
  profileDir: string | null;
}

/**
 * Each browser process is charged to the profile it, or its nearest ancestor, was started with: Chromium's
 * renderers and helpers do not all repeat `--user-data-dir`, but they are all children of the browser
 * process that does. `profiles` maps a profile directory to its account.
 */
export function attributeBrowsers(rows: readonly ProcRow[], profiles: ReadonlyMap<string, string>): ProcessStats["browsers"] {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const totals = new Map<string, { processes: number; memoryKb: number }>();
  for (const row of rows) {
    let cursor: ProcRow | undefined = row;
    let dir: string | null = null;
    for (let depth = 0; cursor && depth < 12; depth++) {
      if (cursor.profileDir) {
        dir = cursor.profileDir;
        break;
      }
      cursor = cursor.ppid ? byPid.get(cursor.ppid) : undefined;
    }
    if (!dir) continue;
    const t = totals.get(dir) ?? { processes: 0, memoryKb: 0 };
    t.processes += 1;
    t.memoryKb += row.memoryKb;
    totals.set(dir, t);
  }
  return [...totals.entries()]
    .map(([dir, t]) => ({ accountId: profiles.get(dir) ?? null, processes: t.processes, memoryMb: round(t.memoryKb / 1024) }))
    .sort((a, b) => b.memoryMb - a.memoryMb);
}

/** cgroup v2 `memory.current` / `memory.max` ("max" = no limit), or v1 `usage_in_bytes` / `limit_in_bytes`. */
export function parseCgroupBytes(text: string | null): number | null {
  const value = text?.trim();
  if (!value || value === "max") return null;
  const n = Number(value);
  // cgroup v1 reports "no limit" as a huge number near 2^63.
  return Number.isFinite(n) && n > 0 && n < 2 ** 60 ? n : null;
}

// ---------------------------------------------------------------------------------------------------------
// Reading the machine. `procRoot` / `cgroupRoot` are test seams.

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

export async function readProcRows(procRoot = "/proc"): Promise<ProcRow[] | null> {
  let entries: string[];
  try {
    entries = await readdir(procRoot);
  } catch {
    return null; // not Linux: unavailable, not "no browsers"
  }
  const rows: ProcRow[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const base = join(procRoot, entry);
    const [cmdline, status, rollup] = await Promise.all([readText(join(base, "cmdline")), readText(join(base, "status")), readText(join(base, "smaps_rollup"))]);
    if (cmdline === null || status === null) continue; // exited between the listing and the read
    const { ppid, rssKb } = parseProcStatus(status);
    const memoryKb = (rollup ? parsePssKb(rollup) : null) ?? rssKb;
    if (memoryKb === null) continue; // a kernel thread
    rows.push({ pid: Number(entry), ppid, memoryKb, profileDir: userDataDir(cmdline.split("\0").filter(Boolean)) });
  }
  return rows;
}

export async function readContainerMemory(cgroupRoot = "/sys/fs/cgroup"): Promise<ProcessStats["container"]> {
  const v2Used = parseCgroupBytes(await readText(join(cgroupRoot, "memory.current")));
  if (v2Used !== null) {
    return { memoryUsedMb: round(v2Used / MB), memoryLimitMb: nullableMb(parseCgroupBytes(await readText(join(cgroupRoot, "memory.max")))) };
  }
  const v1Used = parseCgroupBytes(await readText(join(cgroupRoot, "memory", "memory.usage_in_bytes")));
  return { memoryUsedMb: nullableMb(v1Used), memoryLimitMb: nullableMb(parseCgroupBytes(await readText(join(cgroupRoot, "memory", "memory.limit_in_bytes")))) };
}

function nullableMb(bytes: number | null): number | null {
  return bytes === null ? null : round(bytes / MB);
}

async function readDisk(name: string, path: string): Promise<ProcessStats["disks"][number] | null> {
  try {
    const s = await statfs(path);
    return { name, freeMb: round((s.bavail * s.bsize) / MB), totalMb: round((s.blocks * s.bsize) / MB) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------

const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();

/**
 * One reading. `profiles` maps each account's Chromium profile directory (`<sessionDataPath>/_IGNORE_<sessionId>`,
 * the same path OpenWAProvider launches with) to its account id. The event-loop histogram is reset after
 * each reading, so its percentiles describe the time since the previous one.
 */
export async function collectProcessStats(profiles: ReadonlyMap<string, string>, now = new Date()): Promise<ProcessStats> {
  const mem = process.memoryUsage();
  const loadRaw = os.loadavg()[0]! / os.availableParallelism();
  const sampled = loopDelay.count > 0;
  const stats: ProcessStats = {
    at: now.toISOString(),
    worker: {
      rssMb: round(mem.rss / MB),
      heapUsedMb: round(mem.heapUsed / MB),
      heapTotalMb: round(mem.heapTotal / MB),
      eventLoopP50Ms: sampled ? round(loopDelay.percentile(50) / 1e6) : null,
      eventLoopP99Ms: sampled ? round(loopDelay.percentile(99) / 1e6) : null,
      uptimeMinutes: Math.round(process.uptime() / 60),
    },
    // loadavg is [0,0,0] on Windows; reported as unavailable there rather than as an idle machine.
    host: { cpus: os.availableParallelism(), load1PerCpu: process.platform === "win32" || !Number.isFinite(loadRaw) ? null : round(loadRaw), totalMemMb: round(os.totalmem() / MB), freeMemMb: round(os.freemem() / MB) },
    container: await readContainerMemory(),
    browsers: [],
    disks: [],
  };
  loopDelay.reset();
  const rows = await readProcRows();
  stats.browsers = rows ? attributeBrowsers(rows, profiles) : [];
  const disks = await Promise.all([
    readDisk("media", process.env.MEDIA_STORAGE_DIR ?? "/app/media"),
    readDisk("sessions", process.env.WHATSAPP_SESSION_DIR ?? "/app/sessions"),
  ]);
  stats.disks = disks.filter((d): d is NonNullable<typeof d> => d !== null);
  return stats;
}
