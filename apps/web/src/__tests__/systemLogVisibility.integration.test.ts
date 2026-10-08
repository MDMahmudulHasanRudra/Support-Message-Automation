import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ORIGINAL_PROJECT_ID, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Audit MEDIUM #2: a project's System Logs reader sees the project's own entries, and the platform
 * entries (no project) — the Main Admin Portal's administration of OTHER projects — only if they are
 * a Main Admin. Read through the web's scoped client, exactly as the page reads.
 */

let current: Session | null = null;
vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  getSession: async () => current,
}));

const { runWithProject } = await import("@/server/projectContext");
const { prisma } = await import("@/server/db");
const { systemLogVisibility } = await import("@/server/systemLogVisibility");
const { getSystemLogsSummary } = await import("@/server/actions/dashboardSummary");

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
let mainAdmin: Session;
let reader: Session;
const ids: string[] = [];
let roleIds: string[] = [];

beforeAll(async () => {
  const keys = await Promise.all(
    ["projects.manage", "system_logs.view"].map((key) => {
      const def = PERMISSIONS.find((p) => p.key === key)!;
      return rawPrisma.permission.upsert({ where: { key }, create: { key, label: def.label, category: def.category }, update: {}, select: { id: true, key: true } });
    }),
  );
  const ma = await rawPrisma.permissionModule.create({ data: { name: `LogMA ${tag}`, permissions: { create: keys.map((k) => ({ permissionId: k.id })) } } });
  const rd = await rawPrisma.permissionModule.create({
    data: { name: `LogReader ${tag}`, permissions: { create: keys.filter((k) => k.key === "system_logs.view").map((k) => ({ permissionId: k.id })) } },
  });
  roleIds = [ma.id, rd.id];
  const a = await rawPrisma.user.create({ data: { username: `logma_${tag}`, email: `logma_${tag}@example.test`, name: "MA", passwordHash: "x", permissionModuleId: ma.id } });
  const r = await rawPrisma.user.create({ data: { username: `logrd_${tag}`, email: `logrd_${tag}@example.test`, name: "RD", passwordHash: "x", permissionModuleId: rd.id } });
  mainAdmin = { userId: a.id, username: a.username, email: a.email!, name: a.name } as Session;
  reader = { userId: r.id, username: r.username, email: r.email!, name: r.name } as Session;
  for (const projectId of [ORIGINAL_PROJECT_ID, null]) {
    const row = await rawPrisma.systemLog.create({
      data: { level: "ERROR", scope: `audit-${tag}`, message: projectId ? `own entry ${tag}` : `Project access added for another project ${tag}`, projectId },
    });
    ids.push(row.id);
  }
});

afterAll(async () => {
  await rawPrisma.systemLog.deleteMany({ where: { id: { in: ids } } });
  await rawPrisma.user.deleteMany({ where: { username: { endsWith: tag } } });
  await rawPrisma.permissionModule.deleteMany({ where: { id: { in: roleIds } } });
  await rawPrisma.$disconnect();
});

const inIsp = <T,>(fn: () => Promise<T>) => runWithProject({ id: ORIGINAL_PROJECT_ID, slug: "isp-digital", name: "ISP Digital", status: "ACTIVE" }, fn);
const visibleMessages = async () =>
  inIsp(async () => (await prisma.systemLog.findMany({ where: { scope: `audit-${tag}`, ...(await systemLogVisibility()) }, select: { message: true } })).map((r) => r.message).sort());

describe("System Logs inside a project", () => {
  it("a project reader sees the project's own entries, not the platform's", async () => {
    current = reader;
    expect(await visibleMessages()).toEqual([`own entry ${tag}`]);
  });

  it("a Main Admin also sees platform entries", async () => {
    current = mainAdmin;
    expect(await visibleMessages()).toEqual([`Project access added for another project ${tag}`, `own entry ${tag}`].sort());
  });

  it("the Overview's error count counts what the page shows that viewer", async () => {
    current = reader;
    const asReader = await inIsp(() => getSystemLogsSummary(Date.now()));
    current = mainAdmin;
    const asMainAdmin = await inIsp(() => getSystemLogsSummary(Date.now()));
    expect(asMainAdmin.errors24h - asReader.errors24h).toBeGreaterThanOrEqual(1);
  });

  it("every System Log read on a page applies the rule (or is a documented count)", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const read = (p: string) => readFileSync(`${root}/${p}`, "utf8");
    const logs = read("app/p/[project]/(dashboard)/logs/page.tsx");
    expect(logs).toMatch(/const visible = await systemLogVisibility\(\)/);
    expect(logs).toMatch(/where: Prisma\.SystemLogWhereInput = \{ \.\.\.visible \}/);
    expect(logs).toMatch(/prisma\.systemLog\.count\(\{ where: visible \}\)/);
    expect(read("server/actions/dashboardSummary.ts")).toMatch(/\.\.\.\(await systemLogVisibility\(\)\)/);
  });
});
