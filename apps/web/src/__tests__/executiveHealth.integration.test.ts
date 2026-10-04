import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import * as XLSX from "xlsx";
import { createProjectWithDefaults, ORIGINAL_PROJECT_ID, prisma as rawPrisma } from "@support-automation/db";
import { runWithProject, type ActiveProject } from "@/server/projectContext";
import { buildReport, type BuiltReport } from "@/server/reports";
import { reportWorkbook, tableHeader, tableRows, toCsv } from "@/server/reports/exportFile";
import { duration } from "@/server/reports/format";

/**
 * Executive Support Health (REPORTS.md), against real rows: October 2025, one group for each thing
 * the page must tell apart — answered in time, a customer still waiting at the period end, a customer
 * left for eleven days, an answer that came late, a group gone silent, a group whose activity fell
 * from twenty messages to two. Bizify holds the SAME WhatsApp groups with different messages.
 */

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const at = (month: number, day: number, hh = 10, mm = 0) => new Date(Date.UTC(2025, month - 1, day, hh - 6, mm));
const NOW = at(11, 10, 12);
const OCTOBER = { period: "custom", from: "2025-10-01", to: "2025-10-31" };
const digits = () => `8801${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;

type Key = "ok" | "wait" | "old" | "late" | "silent" | "decline" | "unmonitored";
const wg = {} as Record<Key, string>;
const name = (k: Key) => `EX ${k} ${tag}`;
const ids = { a1: "", team: "", rina: "", bipul: "", biz: "" };
let isp: ActiveProject;
let biz: ActiveProject;
let creatorId = "";
let rinaPhone = "";
let bipulPhone = "";

async function msg(projectId: string, g: { id: string; accountId: string; whatsappGroupId: string }, when: Date, sender: string, direction: "INCOMING" | "SYSTEM" = "INCOMING") {
  await rawPrisma.message.create({
    data: { projectId, accountId: g.accountId, groupId: g.id, chatId: g.whatsappGroupId, whatsappMessageId: `ex-${randomUUID()}`, senderPhone: sender, direction, body: "x", normalizedBody: "x", timestampWa: when, processingStatus: "PROCESSED" },
  });
}

async function run(project: ActiveProject, extra: Record<string, string> = {}): Promise<BuiltReport> {
  return runWithProject(project, async () => (await buildReport("executive-health", { ...OCTOBER, groups: Object.values(wg).join(","), ...extra }, NOW)).report);
}
const tile = (r: BuiltReport, label: string) => r.tiles.find((t) => t.label === label)?.value;
const attention = (r: BuiltReport) => r.tables.find((t) => t.id === "attention")!;
const row = (r: BuiltReport, k: Key) => {
  const t = attention(r);
  const found = t.rows.find((x) => x.cells[0] === name(k));
  return found ? Object.fromEntries(t.columns.map((c, i) => [c.label, found.cells[i]])) : undefined;
};

beforeAll(async () => {
  creatorId = (await rawPrisma.user.create({ data: { username: `ex_${tag}`, email: `ex_${tag}@example.test`, name: "EX", passwordHash: "x" } })).id;
  const ispRow = await rawPrisma.project.findUniqueOrThrow({ where: { id: ORIGINAL_PROJECT_ID } });
  isp = { id: ispRow.id, slug: ispRow.slug, name: ispRow.name, status: ispRow.status };
  const bizRow = await createProjectWithDefaults({ name: `EX Biz ${tag}`, slug: `ex-biz-${tag}`, status: "ACTIVE", creatorUserId: creatorId }, rawPrisma);
  biz = { id: bizRow.id, slug: bizRow.slug, name: `EX Biz ${tag}`, status: "ACTIVE" };
  ids.biz = bizRow.id;

  const pid = { projectId: isp.id };
  ids.a1 = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `EX A1 ${tag}`, status: "CONNECTED" } })).id;
  ids.team = (await rawPrisma.team.create({ data: { ...pid, name: `EX Team ${tag}` } })).id;
  rinaPhone = digits();
  bipulPhone = digits();
  ids.rina = (await rawPrisma.internalTeamMember.create({ data: { ...pid, name: `EX Rina ${tag}`, phoneNumber: rinaPhone, role: "Support", teamId: ids.team } })).id;
  await rawPrisma.teamMembership.create({ data: { ...pid, teamMemberId: ids.rina, teamId: ids.team, startedAt: null } });
  ids.bipul = (await rawPrisma.internalTeamMember.create({ data: { ...pid, name: `EX Bipul ${tag}`, phoneNumber: bipulPhone, role: "Support" } })).id;

  const make = async (k: Key, opts: { monitored?: boolean; assigned?: string | null } = {}) => {
    const g = await rawPrisma.whatsAppGroup.create({
      data: { ...pid, accountId: ids.a1, whatsappGroupId: `ex-${k}-${tag}@g.us`, name: name(k), isMonitored: opts.monitored ?? true, isActive: true, assignedTeamMemberId: opts.assigned ?? null },
    });
    wg[k] = g.whatsappGroupId;
    return g;
  };
  const customer = digits();
  const ok = await make("ok", { assigned: ids.rina });
  await msg(isp.id, ok, at(10, 10, 10, 0), customer);
  await msg(isp.id, ok, at(10, 10, 10, 5), rinaPhone); // answered in 5m
  // System events are not activity: fifteen in September must not make "ok" look like it declined.
  for (let i = 0; i < 15; i++) await msg(isp.id, ok, at(9, 10, 9, i), "system", "SYSTEM");
  const wait = await make("wait");
  await msg(isp.id, wait, at(10, 31, 23, 0), customer); // never answered; 1h before the period ends
  const old = await make("old", { assigned: ids.rina });
  await msg(isp.id, old, at(10, 20, 10, 0), customer); // never answered; days before the period ends
  const late = await make("late", { assigned: ids.bipul });
  await msg(isp.id, late, at(10, 12, 10, 0), customer);
  await msg(isp.id, late, at(10, 12, 10, 48), bipulPhone); // answered after 48m: over the 30m threshold
  const silent = await make("silent");
  await msg(isp.id, silent, at(9, 20, 10, 0), customer); // nothing in October
  const decline = await make("decline");
  for (let i = 0; i < 10; i++) {
    await msg(isp.id, decline, at(9, 5 + i, 10, 0), customer);
    await msg(isp.id, decline, at(9, 5 + i, 10, 2), bipulPhone);
  }
  await msg(isp.id, decline, at(10, 3, 10, 0), customer);
  await msg(isp.id, decline, at(10, 3, 10, 3), bipulPhone); // 20 in September, 2 in October
  const unmonitored = await make("unmonitored", { monitored: false });
  await msg(isp.id, unmonitored, at(10, 15), customer); // waiting, but not a monitored group

  // Bizify: the SAME WhatsApp groups. It talks in "silent" in October and is busy in "decline" in
  // September — a query that forgot the project would change ISP Digital's answer for both.
  const bpid = { projectId: biz.id };
  const bacc = await rawPrisma.whatsAppAccount.create({ data: { ...bpid, label: `EX BIZ ${tag}`, status: "CONNECTED" } });
  const bsilent = await rawPrisma.whatsAppGroup.create({ data: { ...bpid, accountId: bacc.id, whatsappGroupId: wg.silent, name: name("silent"), isMonitored: true, isActive: true } });
  await msg(biz.id, bsilent, at(10, 25), digits());
  const bdecline = await rawPrisma.whatsAppGroup.create({ data: { ...bpid, accountId: bacc.id, whatsappGroupId: wg.decline, name: name("decline"), isMonitored: true, isActive: true } });
  for (let i = 0; i < 50; i++) await msg(biz.id, bdecline, at(9, 10, 8, i), digits());
});

afterAll(async () => {
  await rawPrisma.whatsAppAccount.deleteMany({ where: { id: ids.a1 } });
  await rawPrisma.teamMembership.deleteMany({ where: { teamId: ids.team } });
  await rawPrisma.internalTeamMember.deleteMany({ where: { id: { in: [ids.rina, ids.bipul] } } });
  await rawPrisma.team.deleteMany({ where: { id: ids.team } });
  const tables = (
    await rawPrisma.$queryRaw<Array<{ table_name: string }>>`SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`
  ).map((r) => r.table_name);
  for (let pass = 0; pass < 4; pass++) {
    for (const t of tables) await rawPrisma.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "projectId" = $1`, ids.biz).catch(() => undefined);
  }
  await rawPrisma.project.deleteMany({ where: { id: ids.biz } });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: creatorId } });
  await rawPrisma.user.deleteMany({ where: { id: creatorId } });
  await rawPrisma.$disconnect();
});

describe("the snapshot", () => {
  it("demand, replies, unanswered, missed, response and SLA — the existing definitions", async () => {
    const r = await run(isp);
    expect(tile(r, "Monitored groups")).toBe("6");
    expect(tile(r, "Active groups")).toBe("5");
    expect(tile(r, "No-communication groups")).toBe("1");
    // October customer messages in the selected groups: ok, wait, old, late, decline, unmonitored.
    expect(tile(r, "Customer messages")).toBe("6");
    expect(tile(r, "Team replies")).toBe("3");
    // Waits with no reply: wait, old, unmonitored (all groups in the dataset, as Response SLA counts).
    expect(tile(r, "Unanswered customer waits")).toBe("3");
    // Missed = answered late (late) + never answered (wait, old, unmonitored).
    expect(tile(r, "Missed support")).toBe("4");
    // Answered waits: 5m (ok), 3m (decline), 48m (late).
    expect(tile(r, "Average first response")).toBe(duration(Math.round(((5 + 3 + 48) * 60) / 3)));
    expect(tile(r, "Median first response")).toBe(duration(5 * 60));
    // In time ÷ decided: 2 ÷ (2 + 1 late + 3 never).
    expect(tile(r, "SLA %")).toBe("33.3%");
    expect(tile(r, "Active team members")).toBe("2");
  });
});

describe("attention required", () => {
  it("each group once, under its most urgent issue, most urgent first — a healthy group never appears", async () => {
    const r = await run(isp);
    expect(attention(r).rows.map((x) => x.cells[0])).toEqual([name("old"), name("wait"), name("late"), name("silent"), name("decline")]);
    expect(row(r, "old")).toMatchObject({ Issue: "Prolonged unanswered", Assigned: `EX Rina ${tag}`, Team: `EX Team ${tag}` });
    expect(row(r, "wait")).toMatchObject({ Issue: "Unanswered", Waiting: "1h 00m" });
    expect(row(r, "late")).toMatchObject({ Issue: "SLA breach", Waiting: "48m", Detail: "1 answer after the SLA, worst 48m" });
    expect(row(r, "silent")).toMatchObject({ Issue: "No communication", Waiting: "—" });
    expect(row(r, "decline")).toMatchObject({ Issue: "Declining activity", Detail: "Activity down 90% (20 → 2 messages)" });
    expect(row(r, "ok")).toBeUndefined();
    expect(row(r, "unmonitored")).toBeUndefined();
    expect(tile(r, "Groups requiring attention")).toBe("5");
    expect(tile(r, "Groups with declining activity")).toBe("1");
    expect(tile(r, "Groups with prolonged unanswered")).toBe("1");
  });

  it("the prolonged threshold is the reader's: at one hour, the 1h wait is prolonged too", async () => {
    const r = await run(isp, { prolonged: "1" });
    expect(row(r, "wait")!.Issue).toBe("Prolonged unanswered");
    expect(tile(r, "Groups with prolonged unanswered")).toBe("2");
  });

  it("no communication counts days from the last activity before the period", async () => {
    const r = await run(isp);
    // 20 Sept 10:00 → end of October.
    expect(row(r, "silent")!.Detail).toBe("No communication · 41 days since last activity");
  });
});

describe("before the period ends", () => {
  it("a customer still inside the threshold is unanswered, not missed", async () => {
    // 23:10 on 31 Oct: the 23:00 question in "wait" is ten minutes old — pending.
    const r = await runWithProject(isp, async () => (await buildReport("executive-health", { ...OCTOBER, groups: Object.values(wg).join(",") }, at(10, 31, 23, 10))).report);
    expect(tile(r, "Unanswered customer waits")).toBe("3"); // wait (pending), old, unmonitored
    expect(tile(r, "Missed support")).toBe("3"); // late, old, unmonitored
    expect(row(r, "wait")).toMatchObject({ Issue: "Unanswered", Waiting: "10m" });
  });
});

describe("filters and exports", () => {
  it("Team: groups assigned to, or answered by, the Team's members", async () => {
    const r = await run(isp, { team: ids.team });
    expect(tile(r, "Monitored groups")).toBe("2"); // ok and old, both assigned to Rina
    expect(attention(r).rows.map((x) => x.cells[0])).toEqual([name("old")]);
  });

  it("Groups: only the chosen groups", async () => {
    const r = await run(isp, { groups: [wg.ok, wg.late].join(",") });
    expect(tile(r, "Monitored groups")).toBe("2");
    expect(attention(r).rows.map((x) => x.cells[0])).toEqual([name("late")]);
  });

  it("workload by team: a share of replies per Team, not a score per person", async () => {
    const r = await run(isp);
    const teams = r.tables.find((t) => t.id === "teams")!;
    expect(Object.fromEntries(teams.rows.map((x) => [x.cells[0], x.cells[2]]))).toEqual({ [`EX Team ${tag}`]: 1, "No team": 2 });
  });

  it("CSV is the attention list; Excel has Summary, Detailed and Breakdown", async () => {
    const { report, ctx } = await runWithProject(isp, () => buildReport("executive-health", { ...OCTOBER, groups: Object.values(wg).join(",") }, NOW));
    const t = attention(report);
    const csv = toCsv(tableHeader(t), tableRows(t));
    expect(csv.replace(/^﻿/, "").split(/\r?\n/).filter(Boolean)).toHaveLength(t.rows.length + 1);
    const book = XLSX.read(reportWorkbook(report, ctx), { type: "buffer" });
    expect(book.SheetNames).toEqual(["Summary", "Detailed", "Breakdown"]);
    const summary = XLSX.utils.sheet_to_json<Record<string, unknown>>(book.Sheets.Summary!, { header: 1 }) as unknown as unknown[][];
    expect(summary.some((line) => line[0] === "SLA %" && String(line[1]).startsWith("33.3%"))).toBe(true);
  });
});

describe("project isolation", () => {
  it("Bizify's messages in the same groups never change ISP Digital's answer", async () => {
    const r = await run(isp);
    expect(row(r, "silent")!.Detail).toBe("No communication · 41 days since last activity");
    expect(row(r, "decline")!.Detail).toBe("Activity down 90% (20 → 2 messages)");
  });

  it("and Bizify's report reads Bizify's rows only", async () => {
    const r = await run(biz);
    expect(tile(r, "Monitored groups")).toBe("2");
    expect(tile(r, "Customer messages")).toBe("1"); // its one October message, in "silent"
    // Its "silent" copy has a customer waiting since 25 Oct; its "decline" copy went quiet after September.
    expect(row(r, "silent")!.Issue).toBe("Prolonged unanswered");
    expect(row(r, "decline")!.Issue).toBe("No communication");
    expect(attention(r).rows).toHaveLength(2);
  });
});
