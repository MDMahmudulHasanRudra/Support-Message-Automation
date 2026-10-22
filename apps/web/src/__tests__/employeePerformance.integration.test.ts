import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import * as XLSX from "xlsx";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import type { Session } from "@/server/auth";

/**
 * Unified reporting WP10 on the isolated database: employee ranking, daily engagement and the previous-period
 * comparison are derived from the Team Report's own dataset. Synthetic names and ids only (the Bengali name is
 * made up). A second project holds the same WhatsApp group id and its own people, so a derivation that crosses
 * the project boundary fails here.
 */

let current: Session;
const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const id = (name: string) => `ep-${tag}-${name}`;
const G1 = "120000000000000011@g.us";
const G2 = "120000000000000012@g.us";
const G3 = "120000000000000013@g.us";
const PHONE = { rina: "8801000000011", babul: "8801000000012", mou: "8801000000013", other: "8801000000014", customer: "8801999000011" };
const MOU = "মৌসুমী পরীক্ষা";
/** A Dhaka wall-clock time in October 2025, as an instant. */
const at = (day: number, hh: number, mm = 0) => new Date(Date.UTC(2025, 9, day, hh - 6, mm));
const NOW = at(30, 12);

vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  requireSession: async () => current,
  getSession: async () => current,
}));
vi.mock("@/server/authorize", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/authorize")>()),
  requireAccess: async () => current,
  checkPermission: async () => ({ session: current }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/projectPaths", () => ({ projectPath: async (p: string) => p, inWorkspace: async () => false }));

const { runWithProject } = await import("@/server/projectContext");
const { loadTeamReport, parseTeamReportFilters, teamReportQuery } = await import("@/server/teamReport");
const { analyticsOf, buildRankingTable, loadPreviousPeriod } = await import("@/server/employeePerformance");
const { forgetProjectFeatureStates } = await import("@/server/projectFeatures");
const exportRoute = await import("@/app/p/[project]/api/team-report/export/route");
const tableExport = await import("@/app/p/[project]/api/team-report/table-export/route");

interface Proj {
  id: string;
  slug: string;
  name: string;
  status: "ACTIVE";
}
const projects: { main: Proj; other: Proj } = { main: { id: "", slug: "", name: "", status: "ACTIVE" }, other: { id: "", slug: "", name: "", status: "ACTIVE" } };
let userId = "";
const inMain = <T,>(fn: () => Promise<T>) => runWithProject(projects.main, fn);

let seq = 0;
async function say(project: Proj, o: { chat: string; sender: string; at: Date; customer?: boolean }) {
  seq += 1;
  const key = project === projects.main ? "main" : "other";
  await rawPrisma.message.create({
    data: {
      projectId: project.id,
      accountId: id(`${key}-A`),
      groupId: id(`${key}-${o.chat.slice(-7, -5)}`),
      chatId: o.chat,
      whatsappMessageId: `false_${o.chat}_${seq}_${tag}`,
      senderPhone: o.sender,
      senderJid: `${o.sender}@c.us`,
      direction: "INCOMING",
      body: "text",
      normalizedBody: "text",
      timestampWa: o.at,
      processingStatus: "PROCESSED",
    },
  });
}

const setFlag = async (enabled: boolean) => {
  await rawPrisma.projectFeature.upsert({
    where: { projectId_key: { projectId: projects.main.id, key: "UNIFIED_REPORTING" } },
    create: { projectId: projects.main.id, key: "UNIFIED_REPORTING", enabled },
    update: { enabled },
  });
  forgetProjectFeatureStates();
};

beforeAll(async () => {
  const u = await rawPrisma.user.create({ data: { username: `ep_${tag}`, email: `ep_${tag}@example.test`, name: "EP", passwordHash: "x" } });
  userId = u.id;
  current = { userId: u.id, username: u.username, email: u.email!, name: "EP" } as Session;
  for (const key of ["main", "other"] as const) {
    const created = await createProjectWithDefaults({ name: `EP ${key} ${tag}`, slug: `ep-${key}-${tag}`, status: "ACTIVE", creatorUserId: u.id }, rawPrisma);
    projects[key] = { id: created.id, slug: created.slug, name: `EP ${key} ${tag}`, status: "ACTIVE" };
    const pid = { projectId: created.id };
    await rawPrisma.whatsAppAccount.create({ data: { ...pid, id: id(`${key}-A`), label: `${key} A`, status: "CONNECTED", isPrimary: true } });
    for (const [n, g] of [["11", G1], ["12", G2], ["13", G3]] as const) {
      await rawPrisma.whatsAppGroup.create({ data: { ...pid, id: id(`${key}-${n}`), accountId: id(`${key}-A`), whatsappGroupId: g, name: `${key} group ${n}`, isMonitored: true, isActive: true } });
    }
  }
  const pid = { projectId: projects.main.id };
  const member = (name: string, label: string, phone: string) => rawPrisma.internalTeamMember.create({ data: { ...pid, id: id(name), name: label, phoneNumber: `+${phone}`, role: "Support" } });
  await member("rina", "Rina Test", PHONE.rina);
  await member("babul", "Babul Test", PHONE.babul);
  await member("mou", MOU, PHONE.mou);
  // Another project's person, in the SAME WhatsApp group ids on the same days.
  await rawPrisma.internalTeamMember.create({ data: { projectId: projects.other.id, id: id("outsider"), name: "Outsider Test", phoneNumber: `+${PHONE.other}`, role: "Support" } });

  // Week of Sun 5 Oct - Sat 11 Oct 2025 (Dhaka).
  const m = projects.main;
  await say(m, { chat: G1, sender: PHONE.customer, at: at(6, 8) });
  await say(m, { chat: G1, sender: PHONE.rina, at: at(6, 9) });
  await say(m, { chat: G2, sender: PHONE.rina, at: at(6, 9, 5) });
  await say(m, { chat: G1, sender: PHONE.rina, at: at(7, 9) });
  await say(m, { chat: G3, sender: PHONE.babul, at: at(7, 10) });
  await say(m, { chat: G1, sender: PHONE.rina, at: at(8, 9) });
  await say(m, { chat: G3, sender: PHONE.babul, at: at(8, 10) });
  await say(m, { chat: G1, sender: PHONE.babul, at: at(8, 10, 5) });
  await say(m, { chat: G2, sender: PHONE.mou, at: at(8, 11) });
  // The previous week (Sun 28 Sep - Sat 4 Oct): Rina, once.
  await say(m, { chat: G1, sender: PHONE.rina, at: new Date(Date.UTC(2025, 9, 1, 3)) });
  // The other project: someone else answers in the same group ids, same days.
  await say(projects.other, { chat: G1, sender: PHONE.other, at: at(6, 9) });
  await say(projects.other, { chat: G2, sender: PHONE.other, at: at(7, 9) });
  await say(projects.other, { chat: G3, sender: PHONE.other, at: at(8, 9) });
  // The same NUMBER as a main-project member, in a group the main member did not work that day: a leak would show as an extra group.
  await say(projects.other, { chat: G3, sender: PHONE.rina, at: at(6, 10) });
  await setFlag(true);
}, 120_000);

afterAll(async () => {
  const tables = (
    await rawPrisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`
  ).map((r) => r.table_name);
  for (const project of [projects.main, projects.other]) {
    for (let pass = 0; pass < 6; pass++) {
      for (const name of tables) await rawPrisma.$executeRawUnsafe(`DELETE FROM "${name}" WHERE "projectId" = $1`, project.id).catch(() => undefined);
    }
    await rawPrisma.projectAccess.deleteMany({ where: { projectId: project.id } });
    await rawPrisma.project.deleteMany({ where: { id: project.id } });
  }
  await rawPrisma.user.deleteMany({ where: { id: userId } });
  await rawPrisma.$disconnect();
});

const WEEK = { period: "week", date: "2025-10-08" };
const load = (params: Record<string, string>) => inMain(() => loadTeamReport(parseTeamReportFilters({ ...WEEK, ...params }, NOW), NOW));
const row = (data: Awaited<ReturnType<typeof load>>, name: string) => analyticsOf(data).rows.find((r) => r.memberId === id(name))!;

describe("the same dataset as the Team members table", () => {
  it("groups engaged equals the table's Groups for a day, a week, a month and a custom range", async () => {
    for (const params of [{ period: "day", date: "2025-10-06" }, WEEK, { period: "month", date: "2025-10-15" }, { period: "custom", from: "2025-10-06", to: "2025-10-08" }]) {
      const data = await load(params);
      const analytics = analyticsOf(data);
      expect(analytics.rows.length, JSON.stringify(params)).toBeGreaterThan(0);
      for (const r of analytics.rows) {
        expect(r.groupsEngaged, `${JSON.stringify(params)} ${r.memberId}`).toBe(data.result.members.find((m) => m.memberId === r.memberId)!.groups);
        expect(r.replies).toBe(data.result.members.find((m) => m.memberId === r.memberId)!.messages);
      }
    }
    expect(row(await load({ period: "day", date: "2025-10-06" }), "rina").groupsEngaged).toBe(2);
  });

  it("the daily grid: distinct groups differ from the sum of days, and day totals count each group once", async () => {
    const data = await load({});
    const rina = analyticsOf(data).daily.members.find((m) => m.memberId === id("rina"))!;
    expect(rina.distinctGroups).toBe(2);
    expect(rina.sumOfDays).toBe(4);
    expect(rina.activeDays).toBe(3);
    expect(rina.perDay).toEqual([0, 2, 1, 1, 0, 0, 0]);
    const totals = analyticsOf(data).daily;
    // 8 Oct: Rina G1, Babul G3 and G1, Mou G2 -> three distinct groups, not four engagements
    expect(totals.dayTotals).toEqual([0, 2, 2, 3, 0, 0, 0]);
    expect(totals.distinctOverall).toBe(3);
  });

  it("another project's people and groups never reach the figures (same WhatsApp group ids, same days)", async () => {
    const data = await load({});
    const analytics = analyticsOf(data);
    expect(analytics.rows.map((r) => r.memberId).sort()).toEqual([id("babul"), id("mou"), id("rina")].sort());
    expect(analytics.daily.members.some((m) => m.memberId === id("outsider"))).toBe(false);
    expect(analytics.daily.dayTotals).toEqual([0, 2, 2, 3, 0, 0, 0]);
  });

  it("a Team filter narrows ranking and grid to the Team's members, as the table does", async () => {
    const pid = { projectId: projects.main.id };
    const team = await rawPrisma.team.create({ data: { ...pid, name: `Team ${tag}` } });
    await rawPrisma.teamMembership.create({ data: { ...pid, teamMemberId: id("babul"), teamId: team.id, startedAt: null } });
    const data = await load({ team: team.id });
    const analytics = analyticsOf(data);
    expect(analytics.rows.map((r) => r.memberId)).toEqual([id("babul")]);
    expect(analytics.rows[0]!.groupsEngaged).toBe(data.result.members.find((m) => m.memberId === id("babul"))!.groups);
    expect(analytics.daily.members.map((m) => m.memberId)).toEqual([id("babul")]);
  });

  it("the ranking table shows 'Not enough data' for a small sample, never a last place", async () => {
    const data = await load({});
    const table = buildRankingTable(data, analyticsOf(data));
    const header = table.columns.map((c) => c.label);
    const mou = table.rows.find((r) => r.key === id("mou"))!;
    expect(mou.cells[header.indexOf("Groups engaged rank")]).toBe("Not enough data");
    const rina = table.rows.find((r) => r.key === id("rina"))!;
    expect(rina.cells[header.indexOf("Groups engaged rank")]).toBe(1);
    expect(rina.cells[header.indexOf("Median response time rank")]).toBe("Not enough data");
  });
});

describe("period comparison", () => {
  it("the previous period is the equal-length period before, loaded like any Team Report", async () => {
    const data = await load({});
    const { previous, note } = await inMain(() => loadPreviousPeriod(data, NOW));
    expect(note).toBeNull();
    expect(previous!.report.range.label).toContain("28 Sep");
    const direct = await load({ period: "custom", from: "2025-09-28", to: "2025-10-04" });
    expect(previous!.report.result.summary).toEqual(direct.result.summary);
    expect(previous!.analytics.rows.find((r) => r.memberId === id("rina"))!.replies).toBe(1);
  });

  it("compare=1 survives in the report's links and is absent otherwise", () => {
    expect(teamReportQuery(parseTeamReportFilters(WEEK, NOW))).not.toContain("compare");
    expect(parseTeamReportFilters({ ...WEEK, compare: "1" }, NOW).compare).toBe(true);
    expect(teamReportQuery(parseTeamReportFilters({ ...WEEK, compare: "1" }, NOW))).toContain("compare=1");
    expect(parseTeamReportFilters({ ...WEEK, compare: "0" }, NOW).compare).toBeUndefined();
  });
});

async function workbook(params: string) {
  const res = await inMain(() => exportRoute.GET(new NextRequest(`http://localhost/p/${projects.main.slug}/api/team-report/export?period=week&date=2025-10-08&format=xlsx${params}`)));
  const book = XLSX.read(Buffer.from(await res.arrayBuffer()), { type: "buffer" });
  return book;
}

const LEGACY_SHEETS = ["Summary", "Team Members", "Groups", "Daily", "Missed & Recall", "Overtime by day", "Data quality"];

describe("exports and the feature flag", () => {
  it("flag off: the workbook has exactly the old sheets, with or without compare=1", async () => {
    await setFlag(false);
    try {
      expect((await workbook("")).SheetNames).toEqual(LEGACY_SHEETS);
      expect((await workbook("&compare=1")).SheetNames).toEqual(LEGACY_SHEETS);
    } finally {
      await setFlag(true);
    }
  });

  it("flag on: Ranking and Daily engagement are added; Comparison only with compare=1", async () => {
    const plain = await workbook("");
    expect(plain.SheetNames).toEqual([...LEGACY_SHEETS, "Run information", "Ranking", "Daily engagement", "Customer-specific replies"]);
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(plain.Sheets["Ranking"]!);
    expect(rows.find((r) => r["Team member"] === "Rina Test")!["Groups engaged"]).toBe(2);
    const grid = XLSX.utils.sheet_to_json<Record<string, unknown>>(plain.Sheets["Daily engagement"]!);
    expect(grid.find((r) => r["Team member"] === "Rina Test")!["Distinct groups (period)"]).toBe(2);
    expect(grid.find((r) => r["Team member"] === "Rina Test")!["Sum of daily engagements"]).toBe(4);
    const total = grid.find((r) => String(r["Team member"]).startsWith("All members in scope"))!;
    expect(total["Distinct groups (period)"]).toBe(3);

    const compared = await workbook("&compare=1");
    expect(compared.SheetNames).toContain("Comparison");
    const comparison = XLSX.utils.sheet_to_json<Record<string, unknown>>(compared.Sheets["Comparison"]!);
    const rina = comparison.find((r) => r["Team member"] === "Rina Test")!;
    expect(rina["Replies (before)"]).toBe(1);
    expect(rina["Replies (now)"]).toBe(4);
    expect(rina["Replies change"]).toBe(3);
  });

  it("the table export serves ranking and comparison only with the flag on", async () => {
    const post = (table: string) =>
      inMain(() =>
        tableExport.POST(
          new NextRequest(`http://localhost/p/${projects.main.slug}/api/team-report/table-export?period=week&date=2025-10-08`, {
            method: "POST",
            body: JSON.stringify({ table, format: "csv", keys: [id("rina")] }),
          }),
        ),
      );
    const ranking = await post("ranking");
    expect(ranking.status).toBe(200);
    expect(await ranking.text()).toContain("Rina Test");
    const comparison = await post("comparison");
    expect(comparison.status).toBe(200);
    expect(await comparison.text()).toContain("Replies change");
    await setFlag(false);
    try {
      expect((await post("ranking")).status).toBe(400);
      expect((await post("comparison")).status).toBe(400);
    } finally {
      await setFlag(true);
    }
  });
});
