import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import * as XLSX from "xlsx";
import { createProjectWithDefaults, ORIGINAL_PROJECT_ID, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Reporting data health (SUPPORT_INTELLIGENCE_IMPLEMENTATION_AUDIT.md, stage 1), against real rows:
 * a project's collection gaps and verified-from date decide how far a report period can be trusted,
 * nobody else's gaps ever count, and a quiet group across a gap is "none recorded", not "none".
 */

let current: Session;
vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  requireSession: async () => current,
  getSession: async () => current,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/projectPaths", () => ({ projectPath: async (p: string) => `/p/isp-digital${p}`, inWorkspace: async () => false }));

const { runWithProject } = await import("@/server/projectContext");
const { loadDataHealth } = await import("@/server/dataHealth");
const { buildReport } = await import("@/server/reports");
const { reportWorkbook } = await import("@/server/reports/exportFile");
const { saveReportingVerifiedFrom } = await import("@/server/actions/reportingDataHealth");

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const isp = { id: ORIGINAL_PROJECT_ID, slug: "isp-digital", name: "ISP Digital", status: "ACTIVE" as const };
let biz: { id: string; slug: string; name: string; status: "ACTIVE" };
const inIsp = <T,>(fn: () => Promise<T>) => runWithProject(isp, fn);
// October 2025 in Asia/Dhaka.
const at = (month: number, day: number, hh = 10, mm = 0) => new Date(Date.UTC(2025, month - 1, day, hh - 6, mm));
const START = at(10, 1, 0).getTime();
const END = at(11, 1, 0).getTime();
const NOW = at(11, 10, 12);
const OCTOBER = { period: "custom", from: "2025-10-01", to: "2025-10-31" };
const ids = { a: "", b: "", groupless: "", bizAccount: "", manager: "", viewer: "", roles: [] as string[], creator: "" };
const sessions = {} as Record<"manager" | "viewer", Session>;
let originalVerifiedFrom: Date | null = null;

async function role(name: string, keys: string[]) {
  const permissions = await Promise.all(
    keys.map((key) => {
      const def = PERMISSIONS.find((p) => p.key === key)!;
      return rawPrisma.permission.upsert({ where: { key }, create: { key, label: def.label, category: def.category }, update: {}, select: { id: true } });
    }),
  );
  const r = await rawPrisma.permissionModule.create({ data: { name: `${name} ${tag}`, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } } });
  ids.roles.push(r.id);
  return r.id;
}
async function user(name: string, roleId: string) {
  const u = await rawPrisma.user.create({ data: { username: `${name}_${tag}`, email: `${name}_${tag}@example.test`, name, passwordHash: "x", permissionModuleId: roleId } });
  await rawPrisma.projectAccess.create({ data: { projectId: ORIGINAL_PROJECT_ID, userId: u.id } });
  return { id: u.id, session: { userId: u.id, username: u.username, email: u.email!, name } as Session };
}
const setVerifiedFrom = (projectId: string, value: Date | null) =>
  rawPrisma.supportActivitySettings.upsert({
    where: { projectId },
    update: { reportingVerifiedFrom: value },
    create: { id: projectId === ORIGINAL_PROJECT_ID ? "global" : `sas-${projectId}`, projectId, reportingVerifiedFrom: value },
  });

beforeAll(async () => {
  const m = await user("dh_mgr", await role("DH manage", ["support_activity.view", "support_activity.manage"]));
  const v = await user("dh_view", await role("DH view", ["support_activity.view"]));
  ids.manager = m.id;
  ids.viewer = v.id;
  sessions.manager = m.session;
  sessions.viewer = v.session;
  ids.creator = m.id;
  const settings = await rawPrisma.supportActivitySettings.findUnique({ where: { projectId: ORIGINAL_PROJECT_ID } });
  originalVerifiedFrom = settings?.reportingVerifiedFrom ?? null;

  const pid = { projectId: ORIGINAL_PROJECT_ID };
  ids.a = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `DH Primary ${tag}`, status: "CONNECTED" } })).id;
  await rawPrisma.whatsAppGroup.create({ data: { ...pid, accountId: ids.a, whatsappGroupId: `dh-${tag}@g.us`, name: `DH quiet ${tag}`, isMonitored: true, isActive: true } });
  // A second number, in its own group, with its own failed recovery.
  ids.b = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `DH Second ${tag}`, status: "CONNECTED" } })).id;
  await rawPrisma.whatsAppGroup.create({ data: { ...pid, accountId: ids.b, whatsappGroupId: `dh2-${tag}@g.us`, name: `DH second ${tag}`, isMonitored: true, isActive: true } });
  await rawPrisma.collectionGap.create({ data: { ...pid, accountId: ids.b, cause: "UNREADABLE", startedAt: at(10, 25, 9, 0), endedAt: at(10, 25, 9, 30), recoveryStatus: "FAILED" } });
  // A spare number in no group: its outage cannot have lost a group message.
  ids.groupless = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `DH Spare ${tag}`, status: "DISCONNECTED" } })).id;

  await rawPrisma.collectionGap.createMany({
    data: [
      { ...pid, accountId: ids.a, cause: "WORKER_RESTART", startedAt: at(10, 3, 14, 20), endedAt: at(10, 3, 15, 5), recoveryStatus: "RECOVERED", recoveredCount: 4 },
      { ...pid, accountId: ids.a, cause: "DISCONNECTED", startedAt: at(10, 20, 9, 0), endedAt: at(10, 20, 23, 0), recoveryStatus: "PARTIAL", recoveryNote: "Only the last 12 hours could be read back." },
      { ...pid, accountId: ids.groupless, cause: "DISCONNECTED", startedAt: at(10, 10, 9, 0), endedAt: null },
    ],
  });

  const bizRow = await createProjectWithDefaults({ name: `DH Biz ${tag}`, slug: `dh-biz-${tag}`, status: "ACTIVE", creatorUserId: m.id }, rawPrisma);
  biz = { id: bizRow.id, slug: bizRow.slug, name: `DH Biz ${tag}`, status: "ACTIVE" };
  ids.bizAccount = (await rawPrisma.whatsAppAccount.create({ data: { projectId: biz.id, label: `DH Biz ${tag}`, status: "CONNECTED" } })).id;
  await rawPrisma.whatsAppGroup.create({ data: { projectId: biz.id, accountId: ids.bizAccount, whatsappGroupId: `dh-${tag}@g.us`, name: "Biz copy", isMonitored: true, isActive: true } });
  await rawPrisma.collectionGap.create({
    data: { projectId: biz.id, accountId: ids.bizAccount, cause: "UNREADABLE", startedAt: at(10, 15, 9, 0), endedAt: at(10, 15, 10, 0), recoveryStatus: "FAILED" },
  });
});

afterAll(async () => {
  await setVerifiedFrom(ORIGINAL_PROJECT_ID, originalVerifiedFrom);
  await rawPrisma.whatsAppAccount.deleteMany({ where: { id: { in: [ids.a, ids.b, ids.groupless] } } });
  const tables = (
    await rawPrisma.$queryRaw<Array<{ table_name: string }>>`SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`
  ).map((r) => r.table_name);
  for (let pass = 0; pass < 4; pass++) {
    for (const t of tables) await rawPrisma.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "projectId" = $1`, biz.id).catch(() => undefined);
  }
  await rawPrisma.project.deleteMany({ where: { id: biz.id } });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: { in: [ids.manager, ids.viewer] } } });
  await rawPrisma.user.deleteMany({ where: { id: { in: [ids.manager, ids.viewer] } } });
  await rawPrisma.permissionModule.deleteMany({ where: { id: { in: ids.roles } } });
  await rawPrisma.$disconnect();
});

const health = (project = isp, accountId?: string) =>
  runWithProject(project, () => loadDataHealth({ periodStart: START, periodEnd: END, now: NOW, accountId }));

describe("the period's health", () => {
  it("a partly recovered gap is a DATA_GAP, named with its hours; the spare number's outage does not count", async () => {
    await setVerifiedFrom(ORIGINAL_PROJECT_ID, at(9, 1, 0));
    const h = await health();
    expect(h.status).toBe("DATA_GAP");
    const mine = h.gaps.filter((g) => [ids.a, ids.groupless].includes(g.accountId));
    expect(mine.map((g) => g.cause)).toEqual(["WORKER_RESTART", "DISCONNECTED"]);
    expect(mine.every((g) => g.accountId === ids.a)).toBe(true);
    expect(h.warnings).toContain(
      `Reporting data may be incomplete between 20 Oct 2025, 09:00 – 23:00 — DH Primary ${tag}: disconnected; only part of it could be recovered. Only the last 12 hours could be read back.`,
    );
  });

  it("Bizify's gap never reaches ISP Digital, and Bizify reads only its own", async () => {
    expect((await health()).gaps.some((g) => g.accountId === ids.bizAccount)).toBe(false);
    const b = await health(biz);
    expect(b.gaps.map((g) => g.accountId)).toEqual([ids.bizAccount]);
  });

  it("verified-from decides unverified history; without one, everything is historical", async () => {
    await setVerifiedFrom(ORIGINAL_PROJECT_ID, null);
    const h = await health(isp, ids.a);
    expect(h.unverified).toEqual({ from: START, to: END });
    await setVerifiedFrom(ORIGINAL_PROJECT_ID, at(9, 1, 0));
    expect((await health(isp, ids.a)).unverified).toBeNull();
  });

  it("the account filter narrows to that account's gaps", async () => {
    await setVerifiedFrom(ORIGINAL_PROJECT_ID, at(9, 1, 0));
    expect((await health()).gaps.some((g) => g.accountId === ids.b)).toBe(true);
    const h = await health(isp, ids.a);
    expect(new Set(h.gaps.map((g) => g.accountId))).toEqual(new Set([ids.a]));
  });
});

describe("reports say what was recorded", () => {
  it("Inactive Groups marks the quiet group 'Data gap' and says no communication RECORDED is not proof", async () => {
    await setVerifiedFrom(ORIGINAL_PROJECT_ID, at(9, 1, 0));
    const { report } = await inIsp(() => buildReport("inactive-groups", { ...OCTOBER, account: ids.a }, NOW));
    const table = report.tables.find((t) => t.id === "groups")!;
    const row = table.rows.find((r) => r.cells[0] === `DH quiet ${tag}`)!;
    expect(row.cells[table.columns.findIndex((c) => c.label === "Data")]).toBe("Data gap");
    expect(report.notes.some((n) => n.text.startsWith("No communication RECORDED is not proof that none occurred: collection was incomplete"))).toBe(true);
  });

  it("the export's Summary carries the data health and every caveat", async () => {
    await setVerifiedFrom(ORIGINAL_PROJECT_ID, at(9, 1, 0));
    const { report, ctx } = await inIsp(() => buildReport("inactive-groups", { ...OCTOBER, account: ids.a }, NOW));
    const book = XLSX.read(reportWorkbook(report, ctx), { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets.Summary!, { header: 1 }) as unknown[][];
    expect(rows.find((r) => r[0] === "Data health")?.[1]).toBe("Data gap");
    expect(rows.filter((r) => r[0] === "Data caveat").length).toBe(2);
  });
});

describe("setting verified-from", () => {
  const form = (value: string, intent = "save") => {
    const f = new FormData();
    f.set("verifiedFrom", value);
    f.set("intent", intent);
    return f;
  };

  it("a manager sets it in Asia/Dhaka time, for this project only", async () => {
    current = sessions.manager;
    await setVerifiedFrom(biz.id, null);
    const r = await inIsp(() => saveReportingVerifiedFrom({}, form("2025-10-02T09:30")));
    expect(r.error).toBeUndefined();
    const stored = await rawPrisma.supportActivitySettings.findUniqueOrThrow({ where: { projectId: ORIGINAL_PROJECT_ID } });
    expect(stored.reportingVerifiedFrom?.toISOString()).toBe(at(10, 2, 9, 30).toISOString());
    expect((await rawPrisma.supportActivitySettings.findUniqueOrThrow({ where: { projectId: biz.id } })).reportingVerifiedFrom).toBeNull();
  });

  it("refuses the future, a malformed date, and a viewer; Clear empties it", async () => {
    current = sessions.manager;
    expect((await inIsp(() => saveReportingVerifiedFrom({}, form("2999-01-01T00:00")))).error).toContain("future");
    expect((await inIsp(() => saveReportingVerifiedFrom({}, form("2025-02-31T09:00")))).error).toContain("Enter a date");
    current = sessions.viewer;
    expect((await inIsp(() => saveReportingVerifiedFrom({}, form("2025-10-02T09:30")))).error).toBeTruthy();
    current = sessions.manager;
    await inIsp(() => saveReportingVerifiedFrom({}, form("", "clear")));
    expect((await rawPrisma.supportActivitySettings.findUniqueOrThrow({ where: { projectId: ORIGINAL_PROJECT_ID } })).reportingVerifiedFrom).toBeNull();
  });
});
