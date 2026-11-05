import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attributeBrowsers,
  parseCgroupBytes,
  parseProcStatus,
  parsePssKb,
  readContainerMemory,
  readProcRows,
  userDataDir,
  type ProcRow,
} from "../health/serverStats.js";

/**
 * health/serverStats.ts (P1-08, doc 20 O5): the worker's own reading of memory, browsers and disk.
 * Pure parsing against fixture text, and the readers against fixture directories shaped like /proc and
 * /sys/fs/cgroup. No database, no browser.
 */

const PROFILE_A = "/app/sessions/_IGNORE_session-a";
const PROFILE_B = "/app/sessions/_IGNORE_session-b";

describe("parsing", () => {
  it("reads the parent pid and resident memory from /proc/<pid>/status", () => {
    expect(parseProcStatus("Name:\tchrome\nPPid:\t41\nVmRSS:\t  204800 kB\n")).toEqual({ ppid: 41, rssKb: 204800 });
    expect(parseProcStatus("Name:\tkthreadd\nPPid:\t0\n")).toEqual({ ppid: 0, rssKb: null });
  });

  it("reads proportional memory from smaps_rollup", () => {
    expect(parsePssKb("Rss:  300000 kB\nPss:  120000 kB\n")).toBe(120000);
    expect(parsePssKb("")).toBeNull();
  });

  it("finds the browser profile in a command line", () => {
    expect(userDataDir(["/usr/bin/chromium", `--user-data-dir=${PROFILE_A}`, "--headless"])).toBe(PROFILE_A);
    expect(userDataDir(["node", "dist/index.js"])).toBeNull();
  });

  it("treats cgroup 'max' and v1's huge 'no limit' value as no limit, never as a number", () => {
    expect(parseCgroupBytes("max\n")).toBeNull();
    expect(parseCgroupBytes("9223372036854771712")).toBeNull();
    expect(parseCgroupBytes("536870912\n")).toBe(536870912);
    expect(parseCgroupBytes(null)).toBeNull();
  });
});

describe("attributeBrowsers", () => {
  const profiles = new Map([[PROFILE_A, "acc-a"], [PROFILE_B, "acc-b"]]);
  // The worker (node, pid 10) starts two browsers. Renderers do not repeat --user-data-dir: they are
  // charged to their parent. A third profile no account owns is an orphan.
  const rows: ProcRow[] = [
    { pid: 10, ppid: 1, memoryKb: 300_000, profileDir: null },
    { pid: 20, ppid: 10, memoryKb: 200_000, profileDir: PROFILE_A },
    { pid: 21, ppid: 20, memoryKb: 150_000, profileDir: null },
    { pid: 22, ppid: 21, memoryKb: 50_000, profileDir: null },
    { pid: 30, ppid: 10, memoryKb: 100_000, profileDir: PROFILE_B },
    { pid: 40, ppid: 10, memoryKb: 80_000, profileDir: "/app/sessions/_IGNORE_gone" },
  ];

  it("charges every process to its browser's account, children included, and never counts the worker itself", () => {
    expect(attributeBrowsers(rows, profiles)).toEqual([
      { accountId: "acc-a", processes: 3, memoryMb: 390.6 },
      { accountId: "acc-b", processes: 1, memoryMb: 97.7 },
      { accountId: null, processes: 1, memoryMb: 78.1 },
    ]);
  });

  it("survives a parent loop without hanging", () => {
    const loop: ProcRow[] = [
      { pid: 1, ppid: 2, memoryKb: 10, profileDir: null },
      { pid: 2, ppid: 1, memoryKb: 10, profileDir: null },
    ];
    expect(attributeBrowsers(loop, profiles)).toEqual([]);
  });
});

describe("reading the machine (fixture directories)", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "procstats-"));
    const proc = join(root, "proc");
    const add = async (pid: number, argv: string[], status: string, rollup?: string) => {
      await mkdir(join(proc, String(pid)), { recursive: true });
      await writeFile(join(proc, String(pid), "cmdline"), argv.join("\0") + "\0");
      await writeFile(join(proc, String(pid), "status"), status);
      if (rollup) await writeFile(join(proc, String(pid), "smaps_rollup"), rollup);
    };
    await add(20, ["/usr/bin/chromium", `--user-data-dir=${PROFILE_A}`], "PPid:\t10\nVmRSS:\t204800 kB\n", "Pss:\t102400 kB\n");
    await add(21, ["/usr/bin/chromium", "--type=renderer"], "PPid:\t20\nVmRSS:\t51200 kB\n");
    await mkdir(join(proc, "self"), { recursive: true }); // not a pid: ignored
    await mkdir(join(root, "cg2"), { recursive: true });
    await writeFile(join(root, "cg2", "memory.current"), "1073741824\n");
    await writeFile(join(root, "cg2", "memory.max"), "max\n");
    await mkdir(join(root, "cg1", "memory"), { recursive: true });
    await writeFile(join(root, "cg1", "memory", "memory.usage_in_bytes"), "2147483648\n");
    await writeFile(join(root, "cg1", "memory", "memory.limit_in_bytes"), "4294967296\n");
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("prefers proportional memory over resident, and keeps the parent link", async () => {
    const rows = await readProcRows(join(root, "proc"));
    expect(rows).toEqual(
      expect.arrayContaining([
        { pid: 20, ppid: 10, memoryKb: 102400, profileDir: PROFILE_A },
        { pid: 21, ppid: 20, memoryKb: 51200, profileDir: null },
      ]),
    );
    expect(rows).toHaveLength(2);
  });

  it("reports a missing /proc as unavailable (null), never as 'no browsers'", async () => {
    expect(await readProcRows(join(root, "does-not-exist"))).toBeNull();
  });

  it("reads container memory from cgroup v2 and v1, and a missing cgroup as unavailable", async () => {
    expect(await readContainerMemory(join(root, "cg2"))).toEqual({ memoryUsedMb: 1024, memoryLimitMb: null });
    expect(await readContainerMemory(join(root, "cg1"))).toEqual({ memoryUsedMb: 2048, memoryLimitMb: 4096 });
    expect(await readContainerMemory(join(root, "none"))).toEqual({ memoryUsedMb: null, memoryLimitMb: null });
  });
});
