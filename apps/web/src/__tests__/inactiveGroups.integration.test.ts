import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import * as XLSX from "xlsx";
import { createProjectWithDefaults, ORIGINAL_PROJECT_ID, prisma as rawPrisma } from "@support-automation/db";
import { datePresetParams } from "@support-automation/shared";
import { runWithProject, type ActiveProject } from "@/server/projectContext";
import { buildReport, type BuiltReport } from "@/server/reports";
import { reportWorkbook, tableHeader, tableRows, toCsv } from "@/server/reports/exportFile";

/**
 * Inactive Groups — No Communication (REPORTS.md): which monitored groups had NO stored WhatsApp
 * message of any kind in the period, with their last activity before it.
 *
 * October 2025 is the period throughout (a fixed past month), with groups shaped around every case
 * that must not be confused: silent all along, silent only in the period, only the team posted, only
 * customers posted, first message after the period, not monitored, left. Bizify then holds the SAME
 * WhatsApp groups under the SAME names with different messages, so a query that forgot the project
 * would visibly change ISP Digital's answer.
 */

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
/** A Dhaka wall-clock instant in 2025. */
const at = (month: number, day: number, hh = 10, mm = 0) => new Date(Date.UTC(2025, month - 1, day, hh - 6, mm));
/** Mid-morning Dhaka on 10 Nov 2025: "last month" is October, "this month" is 1–10 November. */
const NOW = at(11, 10, 12);
const OCTOBER = { period: "custom", from: "2025-10-01", to: "2025-10-31" };
const digits = () => `8801${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;

type Key = "none" | "before" | "during" | "team" | "customer" | "after" | "acc2" | "unmonitored" | "left";
const wg = {} as Record<Key, string>;
const name = (k: Key) => `IG ${k} ${tag}`;
const ids = { a1: "", a2: "", rina: "", bipul: "", team: "", biz: "" };
let isp: ActiveProject;
let biz: ActiveProject;
let creatorId = "";
let rinaPhone = "";

async function msg(projectId: string, group: { id: string; accountId: string; whatsappGroupId: string }, when: Date, sender: string, opts: { direction?: "INCOMING" | "OUTGOING"; senderName?: string } = {}) {
  await rawPrisma.message.create({
    data: {
      projectId,
      accountId: group.accountId,
      groupId: group.id,
      chatId: group.whatsappGroupId,
      whatsappMessageId: `ig-${randomUUID()}`,
      senderPhone: sender,
      senderName: opts.senderName ?? null,
      direction: opts.direction ?? "INCOMING",
      body: "x",
      normalizedBody: "x",
      timestampWa: when,
      processingStatus: "PROCESSED",
    },
  });
}

async function run(project: ActiveProject, extra: Record<string, string> = {}, now = NOW): Promise<BuiltReport> {
  return runWithProject(project, async () => (await buildReport("inactive-groups", { ...OCTOBER, groups: Object.values(wg).join(","), ...extra }, now)).report);
}
const groupsTable = (r: BuiltReport) => r.tables.find((t) => t.id === "groups")!;
const names = (r: BuiltReport) => groupsTable(r).rows.map((row) => row.cells[0]);
const cell = (r: BuiltReport, k: Key, label: string) => {
  const t = groupsTable(r);
  const row = t.rows.find((x) => x.cells[0] === name(k));
  return row ? row.cells[t.columns.findIndex((c) => c.label === label)] : undefined;
};
const tile = (r: BuiltReport, label: string) => r.tiles.find((t) => t.label === label)?.value;

beforeAll(async () => {
  creatorId = (await rawPrisma.user.create({ data: { username: `ig_${tag}`, email: `ig_${tag}@example.test`, name: "IG", passwordHash: "x" } })).id;
  const ispRow = await rawPrisma.project.findUniqueOrThrow({ where: { id: ORIGINAL_PROJECT_ID } });
  isp = { id: ispRow.id, slug: ispRow.slug, name: ispRow.name, status: ispRow.status };
  const bizRow = await createProjectWithDefaults({ name: `IG Biz ${tag}`, slug: `ig-biz-${tag}`, status: "ACTIVE", creatorUserId: creatorId }, rawPrisma);
  biz = { id: bizRow.id, slug: bizRow.slug, name: `IG Biz ${tag}`, status: "ACTIVE" };
  ids.biz = bizRow.id;

  const pid = { projectId: isp.id };
  ids.a1 = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `IG A1 ${tag}`, status: "CONNECTED" } })).id;
  ids.a2 = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `IG A2 ${tag}`, status: "DISCONNECTED" } })).id;
  ids.team = (await rawPrisma.team.create({ data: { ...pid, name: `IG Team ${tag}` } })).id;
  rinaPhone = digits();
  ids.rina = (await rawPrisma.internalTeamMember.create({ data: { ...pid, name: `IG Rina ${tag}`, phoneNumber: rinaPhone, role: "Support", teamId: ids.team } })).id;
  await rawPrisma.teamMembership.create({ data: { ...pid, teamMemberId: ids.rina, teamId: ids.team, startedAt: null } });
  ids.bipul = (await rawPrisma.internalTeamMember.create({ data: { ...pid, name: `IG Bipul ${tag}`, phoneNumber: digits(), role: "Support" } })).id;

  const make = async (k: Key, accountId: string, opts: { monitored?: boolean; active?: boolean; assigned?: string | null } = {}) => {
    const g = await rawPrisma.whatsAppGroup.create({
      data: { ...pid, accountId, whatsappGroupId: `ig-${k}-${tag}@g.us`, name: name(k), isMonitored: opts.monitored ?? true, isActive: opts.active ?? true, assignedTeamMemberId: opts.assigned ?? null },
    });
    wg[k] = g.whatsappGroupId;
    return g;
  };
  const customer = digits();
  await make("none", ids.a1, { assigned: ids.bipul }); // never a stored message
  const before = await make("before", ids.a1, { assigned: ids.rina });
  await msg(isp.id, before, at(9, 1), customer, { senderName: "Old customer" });
  await msg(isp.id, before, at(9, 10, 15, 30), customer, { senderName: "Hasib" }); // the last activity, before the period
  const during = await make("during", ids.a1);
  await msg(isp.id, during, at(9, 1), customer);
  await msg(isp.id, during, at(10, 15), customer);
  const team = await make("team", ids.a1);
  await msg(isp.id, team, at(10, 5), rinaPhone); // only a team member, in the period
  const cust = await make("customer", ids.a1);
  await msg(isp.id, cust, at(10, 7), customer);
  await msg(isp.id, cust, at(10, 8), customer); // only customers, in the period, never answered
  const after = await make("after", ids.a1);
  await msg(isp.id, after, at(11, 5), customer); // first message after the period
  await make("acc2", ids.a2); // silent, on a disconnected second account
  await make("unmonitored", ids.a1, { monitored: false });
  await make("left", ids.a1, { active: false });

  // Bizify: the SAME WhatsApp groups, the SAME names, different messages — all of them active in October.
  const bpid = { projectId: biz.id };
  const bacc = await rawPrisma.whatsAppAccount.create({ data: { ...bpid, label: `IG BIZ ${tag}`, status: "CONNECTED" } });
  for (const k of ["none", "before", "acc2"] as const) {
    const g = await rawPrisma.whatsAppGroup.create({ data: { ...bpid, accountId: bacc.id, whatsappGroupId: wg[k], name: name(k), isMonitored: true, isActive: true } });
    await msg(biz.id, g, at(10, 20), digits(), { senderName: "Bizify customer" });
    await msg(biz.id, g, at(9, 25), digits(), { senderName: "Bizify earlier" });
  }
});

afterAll(async () => {
  await rawPrisma.whatsAppAccount.deleteMany({ where: { id: { in: [ids.a1, ids.a2] } } });
  await rawPrisma.teamMembership.deleteMany({ where: { teamId: ids.team } });
  await rawPrisma.internalTeamMember.deleteMany({ where: { id: { in: [ids.rina, ids.bipul] } } });
  await rawPrisma.team.deleteMany({ where: { id: ids.team } });
  const tables = (
    await rawPrisma.$queryRaw<Array<{ table_name: string }>>`SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`
  ).map((row) => row.table_name);
  for (let pass = 0; pass < 4; pass++) {
    for (const t of tables) await rawPrisma.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "projectId" = $1`, ids.biz).catch(() => undefined);
  }
  await rawPrisma.project.deleteMany({ where: { id: ids.biz } });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: creatorId } });
  await rawPrisma.user.deleteMany({ where: { id: creatorId } });
  await rawPrisma.$disconnect();
});

describe("which groups had no communication", () => {
  it("lists the groups with zero stored messages in the period — and only those", async () => {
    const r = await run(isp);
    // never recorded; silent since September; first message after the period; silent on account 2.
    expect(new Set(names(r))).toEqual(new Set([name("none"), name("before"), name("after"), name("acc2")]));
    // Active in the period (1), only the team posted (4), only customers posted (5): all had communication.
    for (const k of ["during", "team", "customer"] as const) expect(names(r)).not.toContain(name(k));
    for (const k of ["none", "before", "after", "acc2"] as const) {
      expect(cell(r, k, "Messages in period")).toBe(0);
      expect(cell(r, k, "Status")).toBe("No communication");
    }
  });

  it("separates 'no message at all' from 'no customer message' and 'no reply'", async () => {
    const r = await run(isp, { status: "all" });
    expect(cell(r, "team", "Status")).toBe("No customer activity");
    expect(cell(r, "team", "Team replies")).toBe(1);
    expect(cell(r, "customer", "Status")).toBe("Customer activity, no reply");
    expect(cell(r, "customer", "Customer messages")).toBe(2);
    expect(cell(r, "during", "Messages in period")).toBe(1);
  });

  it("last activity is the latest message BEFORE the period, with who sent it and the days since", async () => {
    const r = await run(isp);
    expect(cell(r, "before", "Last activity")).toBe("10 Sept, 15:30");
    expect(cell(r, "before", "Last activity by")).toBe("Customer · Hasib");
    // 10 Sep 15:30 → end of October (1 Nov 00:00 Dhaka): 51 whole days.
    expect(cell(r, "before", "Days since last activity")).toBe(51);
  });

  it("a group with no stored message is 'Never recorded'; one whose first message came after the period is not", async () => {
    const r = await run(isp);
    expect(cell(r, "none", "Last activity")).toBe("Never recorded");
    expect(cell(r, "none", "Days since last activity")).toBe("—");
    expect(cell(r, "after", "Last activity")).toBe("None before the period end");
    expect(tile(r, "Never recorded")).toBe("2"); // "none", and the silent group on account 2
  });

  it("follows the Reports definition of eligible groups: monitored and active today; the account's state is shown", async () => {
    const r = await run(isp, { status: "all" });
    expect(names(r)).not.toContain(name("unmonitored"));
    expect(names(r)).not.toContain(name("left"));
    expect(cell(r, "acc2", "WhatsApp account")).toBe(`IG A2 ${tag}`);
    expect(cell(r, "acc2", "Monitoring")).toBe("Monitored · account disconnected");
    expect(cell(r, "before", "Team")).toBe(`IG Team ${tag}`);
    expect(cell(r, "none", "Team")).toBe("—");
  });

  it("KPI cards: totals, share, longest silence, and the headline sentence", async () => {
    const r = await run(isp);
    expect(tile(r, "Monitored groups")).toBe("7");
    expect(tile(r, "With communication")).toBe("3");
    expect(tile(r, "No communication")).toBe("4");
    expect(tile(r, "No-communication share")).toBe("57.1%");
    expect(tile(r, "Longest silence")).toBe("51 days");
    expect(r.tiles.find((t) => t.label === "Longest silence")?.hint).toContain(name("before"));
    expect(r.notes[0]!.text).toMatch(/^No communication · .*4 of 7 monitored groups had no recorded WhatsApp activity during this period\.$/);
  });

  it("when every group had activity it says so, with an empty list", async () => {
    const r = await run(isp, { groups: [wg.during, wg.team].join(",") });
    expect(groupsTable(r).rows).toHaveLength(0);
    expect(r.notes[0]!.text).toMatch(/^All monitored groups had activity during this period/);
    expect(r.emptyMessage).toBeNull();
  });
});

describe("filters", () => {
  it("custom range: a period that covers the September message no longer lists that group", async () => {
    const r = await run(isp, { from: "2025-09-01", to: "2025-10-31" });
    expect(names(r)).not.toContain(name("before"));
    expect(names(r)).toContain(name("none"));
  });

  it("quick presets resolve to the right periods", async () => {
    const lastMonth = await run(isp, datePresetParams("last_month", NOW) as unknown as Record<string, string>);
    expect(new Set(names(lastMonth))).toEqual(new Set(names(await run(isp))));
    const thisMonth = await run(isp, datePresetParams("this_month", NOW) as unknown as Record<string, string>);
    expect(names(thisMonth)).not.toContain(name("after")); // its message is 5 November
    expect(names(thisMonth)).toContain(name("during"));
    const last90 = await run(isp, datePresetParams("last_90_days", NOW) as unknown as Record<string, string>);
    expect(names(last90)).not.toContain(name("before"));
    const last7 = await run(isp, datePresetParams("last_7_days", NOW) as unknown as Record<string, string>);
    // 4–10 November: the group whose message is 5 November had communication; the October ones did not.
    expect(names(last7)).not.toContain(name("after"));
    expect(names(last7)).toEqual(expect.arrayContaining([name("during"), name("team"), name("customer")]));
    for (const id of ["today", "yesterday", "last_30_days", "last_60_days"] as const) {
      await expect(run(isp, datePresetParams(id, NOW) as unknown as Record<string, string>)).resolves.toBeTruthy();
    }
  });

  it("Team: groups assigned to, or answered by, the Team's members", async () => {
    const r = await run(isp, { team: ids.team, status: "all" });
    expect(new Set(names(r))).toEqual(new Set([name("before"), name("team")]));
    expect(names(await run(isp, { team: ids.team }))).toEqual([name("before")]);
  });

  it("Member: the groups assigned to that member", async () => {
    expect(names(await run(isp, { member: ids.bipul }))).toEqual([name("none")]);
  });

  it("Groups: only the chosen groups are counted", async () => {
    const r = await run(isp, { groups: [wg.none, wg.during].join(",") });
    expect(names(r)).toEqual([name("none")]);
    expect(tile(r, "Monitored groups")).toBe("2");
  });

  it("WhatsApp account: only that account's groups", async () => {
    const a2 = await run(isp, { account: ids.a2 });
    expect(names(a2)).toEqual([name("acc2")]);
    const a1 = await run(isp, { account: ids.a1 });
    expect(names(a1)).not.toContain(name("acc2"));
  });
});

describe("exports use the screen's own table", () => {
  it("CSV: the same rows and columns as the list", async () => {
    const r = await run(isp);
    const t = groupsTable(r);
    const csv = toCsv(tableHeader(t), tableRows(t));
    const lines = csv.replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
    expect(lines).toHaveLength(t.rows.length + 1);
    expect(lines[0]).toContain("Last activity by");
    for (const row of t.rows) expect(csv).toContain(String(row.cells[0]));
  });

  it("Excel: Summary, the detailed list and the activity summary — matching the screen", async () => {
    const { report, ctx } = await runWithProject(isp, () => buildReport("inactive-groups", { ...OCTOBER, groups: Object.values(wg).join(",") }, NOW));
    const book = XLSX.read(reportWorkbook(report, ctx), { type: "buffer" });
    expect(book.SheetNames).toEqual(["Summary", "Detailed", "Breakdown"]);
    const detailed = XLSX.utils.sheet_to_json<Record<string, unknown>>(book.Sheets.Detailed!);
    expect(detailed.map((row) => row.Group)).toEqual(groupsTable(report).rows.map((row) => row.cells[0]));
    const summary = XLSX.utils.sheet_to_json<Record<string, unknown>>(book.Sheets.Breakdown!);
    expect(summary.find((row) => row.Status === "No communication")?.Groups).toBe(4);
  });
});

describe("project isolation", () => {
  it("Bizify's messages in the SAME groups under the SAME names never reach ISP Digital's answer", async () => {
    const r = await run(isp);
    // Bizify spoke in "none", "before" and "acc2" in October. ISP Digital did not.
    expect(names(r)).toEqual(expect.arrayContaining([name("none"), name("before"), name("acc2")]));
    expect(cell(r, "none", "Last activity")).toBe("Never recorded");
    expect(cell(r, "before", "Last activity")).toBe("10 Sept, 15:30");
    expect(cell(r, "before", "Last activity by")).toBe("Customer · Hasib");
  });

  it("and Bizify's report counts only Bizify's groups and messages", async () => {
    const r = await run(biz, { status: "all" });
    expect(new Set(names(r))).toEqual(new Set([name("none"), name("before"), name("acc2")]));
    for (const k of ["none", "before", "acc2"] as const) expect(cell(r, k, "Messages in period")).toBe(1);
    expect(tile(r, "No communication")).toBe("0");
  });
});
