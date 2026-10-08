import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import * as XLSX from "xlsx";
import { createProjectWithDefaults, ORIGINAL_PROJECT_ID, prisma as rawPrisma } from "@support-automation/db";
import { GENERIC_REPORT_IDS } from "@support-automation/shared";
import { runWithProject, type ActiveProject } from "@/server/projectContext";
import { buildReport, type BuiltReport } from "@/server/reports";
import { reportWorkbook, tableHeader, tableRows, toCsv } from "@/server/reports/exportFile";
import { loadTeamReport, parseTeamReportFilters } from "@/server/teamReport";

/**
 * REPORTS.md: every report at /reports/<id>, against real rows in the throwaway database.
 *
 * One fixed Dhaka day (12 Mar 2025, a Wednesday) and the next, with a fixture whose every figure is
 * worked out by hand below — waits, SLA, coverage, statuses, call mentions, an overnight shift. Then
 * the isolation method of projectReports.integration.test.ts: every report is taken for ISP Digital,
 * Bizify is filled with DIFFERENT data in the SAME WhatsApp group, and ISP Digital's reports must not
 * move by a byte while Bizify's count only Bizify's rows.
 */

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const D = "2025-03-12";
const D1 = "2025-03-13";
/** A Dhaka wall-clock time on D (dayOffset days later), as an instant. */
const t = (hh: number, mm: number, dayOffset = 0) => new Date(Date.UTC(2025, 2, 12 + dayOffset, hh - 6, mm));
const SHARED_WGID = `rep-shared-${tag}@g.us`;
/** One clock for every report in this file, so two runs of one report can only differ by their data. */
const NOW = new Date();
const digits = () => `8801${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;

let isp: ActiveProject;
let biz: ActiveProject;
let empty: ActiveProject;
let creatorId: string;
let savedSettings: { offlineAfterMinutes: number; missedReplyAfterMinutes: number } | null = null;

const ids = {
  wg: {} as Record<"busy" | "silent" | "low" | "quiet" | "acc2", string>,
  accounts: {} as Record<"a1" | "a2", string>,
  m1: "",
  m2: "",
  team: "",
};
let bizGroupName = "";
const bizIds = { account: "", member: "" };
let bizMemberName = "";

async function seedIsp() {
  const pid = { projectId: isp.id };
  const a1 = await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `ISP rep A1 ${tag}`, status: "CONNECTED" } });
  const a2 = await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `ISP rep A2 ${tag}`, status: "CONNECTED" } });
  ids.accounts = { a1: a1.id, a2: a2.id };
  const team = await rawPrisma.team.create({ data: { ...pid, name: `Rep Team ${tag}` } });
  ids.team = team.id;
  const m1Phone = digits();
  const m2Phone = digits();
  const m1 = await rawPrisma.internalTeamMember.create({ data: { ...pid, name: `Rina ${tag}`, phoneNumber: m1Phone, role: "Support", teamId: team.id } });
  const m2 = await rawPrisma.internalTeamMember.create({ data: { ...pid, name: `Bipul ${tag}`, phoneNumber: m2Phone, role: "Support" } });
  await rawPrisma.teamMembership.create({ data: { ...pid, teamMemberId: m1.id, teamId: team.id, startedAt: null } });
  ids.m1 = m1.id;
  ids.m2 = m2.id;

  const group = (key: keyof typeof ids.wg, wgid: string, accountId: string, assigned: string | null) =>
    rawPrisma.whatsAppGroup.create({
      data: { ...pid, accountId, whatsappGroupId: wgid, name: `ISP ${key} ${tag}`, isMonitored: true, isActive: true, lastSyncedAt: new Date(), assignedTeamMemberId: assigned },
    });
  const busy = await group("busy", SHARED_WGID, a1.id, m1.id);
  const silent = await group("silent", `rep-silent-${tag}@g.us`, a1.id, m2.id);
  const low = await group("low", `rep-low-${tag}@g.us`, a1.id, null);
  const quiet = await group("quiet", `rep-quiet-${tag}@g.us`, a1.id, m1.id);
  const acc2 = await group("acc2", `rep-acc2-${tag}@g.us`, a2.id, null);
  ids.wg = { busy: busy.whatsappGroupId, silent: silent.whatsappGroupId, low: low.whatsappGroupId, quiet: quiet.whatsappGroupId, acc2: acc2.whatsappGroupId };

  const customer = digits();
  const msg = (g: { id: string; accountId: string; whatsappGroupId: string }, at: Date, body: string, sender: string, direction: "INCOMING" | "OUTGOING" = "INCOMING") =>
    rawPrisma.message.create({
      data: {
        ...pid,
        accountId: g.accountId,
        groupId: g.id,
        chatId: g.whatsappGroupId,
        whatsappMessageId: `wamid-${randomUUID()}`,
        senderPhone: sender,
        isFromTeamMember: sender !== customer && direction === "INCOMING",
        direction,
        body,
        normalizedBody: body.toLowerCase(),
        timestampWa: at,
        processingStatus: "PROCESSED",
      },
    });
  // G_busy: w1 answered in 10m by Rina, w2 answered in 45m by Bipul (late), w3 answered in 5m by Rina.
  await msg(busy, t(9, 0), "Please call me about my bill", customer);
  await msg(busy, t(9, 10), `ami call dicchi, ref ${tag}`, m1Phone);
  await msg(busy, t(10, 0), "internet slow", customer);
  await msg(busy, t(10, 45), "checking", m2Phone);
  await msg(busy, t(11, 0), "fixed", m1Phone);
  await msg(busy, t(12, 0), "thanks", customer);
  await msg(busy, t(12, 5), "welcome", m1Phone);
  // Bipul's night shift, 22:00–06:00: two stretches either side of midnight.
  await msg(busy, t(23, 0), "night check", m2Phone);
  await msg(busy, t(23, 30), "still fine", m2Phone);
  await msg(busy, t(1, 0, 1), "router reboot done", m2Phone);
  await msg(busy, t(1, 20, 1), "all good", m2Phone);
  // G_silent: one customer question nobody answered.
  await msg(silent, t(14, 0), "hello? anyone", customer);
  // G_low: two messages.
  await msg(low, t(15, 0), "ekta call den", customer);
  await msg(low, t(15, 5), "ok", m2Phone);
  // G_quiet: nothing in the period, one message a month before.
  await msg(quiet, t(10, 0, -30), "old question", customer);
  // G_acc2: on the second number, answered from the business phone.
  await msg(acc2, t(16, 0), "need help", customer);
  await msg(acc2, t(16, 2), "we're on it", a2.id, "OUTGOING");

  const date = (key: string) => new Date(`${key}T00:00:00Z`);
  await rawPrisma.dutyAssignment.create({ data: { ...pid, teamMemberId: m1.id, dutyDate: date(D), status: "DUTY", shiftName: "Day", shiftStartMinute: 600, shiftEndMinute: 1140 } });
  await rawPrisma.dutyAssignment.create({ data: { ...pid, teamMemberId: m2.id, dutyDate: date(D), status: "DUTY", shiftName: "Night", shiftStartMinute: 1320, shiftEndMinute: 360 } });
  await rawPrisma.dutyAssignment.create({ data: { ...pid, teamMemberId: m2.id, dutyDate: date(D1), status: "OFF" } });
}

async function seedBiz() {
  const pid = { projectId: biz.id };
  const account = await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `BIZ rep ${tag}`, status: "CONNECTED" } });
  bizGroupName = `BIZ shared ${tag}`;
  bizMemberName = `Bizify Member ${tag}`;
  // The SAME WhatsApp group as ISP Digital's busiest one: a query joining on the WhatsApp group id
  // instead of the project would mix the two.
  const group = await rawPrisma.whatsAppGroup.create({
    data: { ...pid, accountId: account.id, whatsappGroupId: SHARED_WGID, name: bizGroupName, isMonitored: true, isActive: true, lastSyncedAt: new Date() },
  });
  const memberPhone = digits();
  const member = await rawPrisma.internalTeamMember.create({ data: { ...pid, name: bizMemberName, phoneNumber: memberPhone, role: "Support" } });
  bizIds.account = account.id;
  bizIds.member = member.id;
  const customer = digits();
  const rows: Array<[Date, string, string, "INCOMING" | "OUTGOING"]> = [
    [t(8, 0), "I got a missed call from you", customer, "INCOMING"],
    [t(8, 50), "sorry, calling you now", memberPhone, "INCOMING"],
    [t(13, 0), "15 min call hoise, thanks", customer, "INCOMING"],
    [t(20, 0), "invoice please", customer, "INCOMING"],
    [t(21, 30), "sent", account.id, "OUTGOING"],
    [t(9, 0, 1), "one more thing", customer, "INCOMING"],
  ];
  for (const [at, body, sender, direction] of rows) {
    await rawPrisma.message.create({
      data: {
        ...pid,
        accountId: account.id,
        groupId: group.id,
        chatId: SHARED_WGID,
        whatsappMessageId: `wamid-${randomUUID()}`,
        senderPhone: sender,
        isFromTeamMember: sender === memberPhone,
        direction,
        body,
        normalizedBody: body.toLowerCase(),
        timestampWa: at,
        processingStatus: "PROCESSED",
      },
    });
  }
  await rawPrisma.dutyAssignment.create({
    data: { ...pid, teamMemberId: member.id, dutyDate: new Date(`${D}T00:00:00Z`), status: "DUTY", shiftName: "Early", shiftStartMinute: 420, shiftEndMinute: 960 },
  });
  // Bizify is also in ISP Digital's quiet group, and spoke there five days before the period: a
  // "last message" read across projects would make ISP Digital's quiet group six days quiet, not 31.
  const quiet = await rawPrisma.whatsAppGroup.create({
    data: { ...pid, accountId: account.id, whatsappGroupId: ids.wg.quiet, name: `BIZ quiet ${tag}`, isMonitored: true, isActive: true, lastSyncedAt: new Date() },
  });
  await rawPrisma.message.create({
    data: {
      ...pid,
      accountId: account.id,
      groupId: quiet.id,
      chatId: ids.wg.quiet,
      whatsappMessageId: `wamid-${randomUUID()}`,
      senderPhone: customer,
      direction: "INCOMING",
      body: "bizify quiet group",
      normalizedBody: "bizify quiet group",
      timestampWa: t(10, 0, -5),
      processingStatus: "PROCESSED",
    },
  });
}

const PERIOD = { period: "custom", from: D, to: D1 };
const fixtureGroups = () => Object.values(ids.wg).join(",");

async function run(project: ActiveProject, id: string, extra: Record<string, string> = {}): Promise<BuiltReport> {
  return runWithProject(project, async () => (await buildReport(id, { ...PERIOD, ...extra }, NOW)).report);
}
const table = (report: BuiltReport, tableId: string) => report.tables.find((x) => x.id === tableId)!;
const tile = (report: BuiltReport, label: string) => report.tiles.find((x) => x.label === label)?.value;
const column = (report: BuiltReport, tableId: string, label: string) => {
  const tb = table(report, tableId);
  const i = tb.columns.findIndex((c) => c.label === label);
  return tb.rows.map((r) => r.cells[i]);
};

async function everyReport(project: ActiveProject) {
  const out: Record<string, string> = {};
  for (const id of GENERIC_REPORT_IDS) out[id] = JSON.stringify(await run(project, id));
  return out;
}

let ispBefore: Record<string, string>;
let ispAfter: Record<string, string>;
let bizReports: Record<string, string>;

beforeAll(async () => {
  const user = await rawPrisma.user.create({ data: { username: `reps_${tag}`, email: `reps_${tag}@example.test`, name: "Reports", passwordHash: "x" } });
  creatorId = user.id;
  const ispRow = await rawPrisma.project.findUniqueOrThrow({ where: { id: ORIGINAL_PROJECT_ID } });
  isp = { id: ispRow.id, slug: ispRow.slug, name: ispRow.name, status: ispRow.status };
  const created = await createProjectWithDefaults({ name: `Bizify ${tag}`, slug: `bizrep-${tag}`, status: "ACTIVE", creatorUserId: creatorId }, rawPrisma);
  biz = { id: created.id, slug: created.slug, name: `Bizify ${tag}`, status: "ACTIVE" };
  const emptyRow = await createProjectWithDefaults({ name: `Empty ${tag}`, slug: `emptyrep-${tag}`, status: "ACTIVE", creatorUserId: creatorId }, rawPrisma);
  empty = { id: emptyRow.id, slug: emptyRow.slug, name: `Empty ${tag}`, status: "ACTIVE" };

  // The hand-worked figures below assume the shipped defaults: 120-minute idle gap, 30-minute Missed.
  const settings = await rawPrisma.supportActivitySettings.findFirst({ where: { projectId: isp.id } });
  if (settings) {
    savedSettings = { offlineAfterMinutes: settings.offlineAfterMinutes, missedReplyAfterMinutes: settings.missedReplyAfterMinutes };
    await rawPrisma.supportActivitySettings.update({ where: { id: settings.id }, data: { offlineAfterMinutes: 120, missedReplyAfterMinutes: 30 } });
  }

  await seedIsp();
  ispBefore = await everyReport(isp);
  await seedBiz();
  ispAfter = await everyReport(isp);
  bizReports = await everyReport(biz);
}, 120_000);

afterAll(async () => {
  const tables = (
    await rawPrisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`
  ).map((row) => row.table_name);
  for (let pass = 0; pass < 6; pass++) {
    for (const name of tables) {
      await rawPrisma.$executeRawUnsafe(`DELETE FROM "${name}" WHERE "projectId" = ANY($1)`, [biz.id, empty.id]).catch(() => undefined);
    }
  }
  await rawPrisma.project.deleteMany({ where: { id: { in: [biz.id, empty.id] } } });
  for (const accountId of Object.values(ids.accounts)) {
    await rawPrisma.message.deleteMany({ where: { accountId } });
    await rawPrisma.whatsAppGroup.deleteMany({ where: { accountId } });
    await rawPrisma.whatsAppAccount.deleteMany({ where: { id: accountId } });
  }
  await rawPrisma.dutyAssignment.deleteMany({ where: { teamMemberId: { in: [ids.m1, ids.m2] } } });
  await rawPrisma.teamMembership.deleteMany({ where: { teamMemberId: { in: [ids.m1, ids.m2] } } });
  await rawPrisma.internalTeamMember.deleteMany({ where: { id: { in: [ids.m1, ids.m2] } } });
  await rawPrisma.team.deleteMany({ where: { id: ids.team } });
  if (savedSettings) await rawPrisma.supportActivitySettings.updateMany({ where: { projectId: isp.id }, data: savedSettings });
  await rawPrisma.user.deleteMany({ where: { id: creatorId } });
  await rawPrisma.$disconnect();
});

describe("calculations, against the hand-worked fixture", () => {
  it("Response SLA: 6 waits — 4 within, 1 late, 1 never; median 0h 5m, p90 and worst 0h 45m", async () => {
    const r = await run(isp, "response-sla", { groups: fixtureGroups() });
    expect(tile(r, "Customer waits")).toBe("6");
    expect(tile(r, "Within SLA")).toBe("66.7%");
    expect(tile(r, "Median first response")).toBe("0h 5m");
    expect(tile(r, "90th percentile")).toBe("0h 45m");
    expect(tile(r, "Worst")).toBe("0h 45m");
    expect(tile(r, "Breached")).toBe("2");
    // By who answered: Rina closed two (10m, 5m), Bipul two (45m late, 5m), the business number one.
    const names = column(r, "members", "Answered by");
    expect(names).toEqual(expect.arrayContaining([`Rina ${tag}`, `Bipul ${tag}`, "Business number"]));
  });

  it("Group Support Coverage: the silent group is 0%, the rest 100%", async () => {
    const r = await run(isp, "group-coverage", { groups: fixtureGroups() });
    expect(tile(r, "Coverage")).toBe("83.3%");
    const groups = column(r, "groups", "Group");
    const coverage = column(r, "groups", "Coverage");
    expect(groups[0]).toBe(`ISP silent ${tag}`);
    expect(coverage[0]).toBe("0.0%");
    expect(coverage.slice(1)).toEqual(["100.0%", "100.0%", "100.0%"]);
  });

  it("Inactive Groups: each status, and days since the last message", async () => {
    const r = await run(isp, "inactive-groups", { groups: fixtureGroups(), status: "all" });
    const status = Object.fromEntries(table(r, "groups").rows.map((row) => [row.cells[0], row.cells[3]]));
    expect(status).toEqual({
      [`ISP busy ${tag}`]: "Active",
      [`ISP silent ${tag}`]: "Customer activity, no reply",
      [`ISP low ${tag}`]: "Low activity",
      // Not one message in the period: no communication (it was "No customer activity" before the
      // report learned to tell no message at all apart from no customer message).
      [`ISP quiet ${tag}`]: "No communication",
      [`ISP acc2 ${tag}`]: "Low activity",
    });
    const quiet = table(r, "groups").rows.find((row) => row.cells[0] === `ISP quiet ${tag}`)!;
    expect(quiet.cells[6]).toBe(31);
    // The default view is the report's question: no communication at all.
    const silent = await run(isp, "inactive-groups", { groups: fixtureGroups() });
    expect(table(silent, "groups").rows.map((row) => row.cells[0])).toEqual([`ISP quiet ${tag}`]);
    // "Needing attention" still hides the active ones.
    const attention = await run(isp, "inactive-groups", { groups: fixtureGroups(), status: "attention" });
    expect(table(attention, "groups").rows).toHaveLength(4);
  });

  it("Missed Support: late and never answered by default, with the customer's own words", async () => {
    const r = await run(isp, "missed", { groups: fixtureGroups() });
    expect(column(r, "waits", "Status")).toEqual(["Never answered", "Answered late"]);
    expect(column(r, "waits", "Customer's message")).toEqual(["hello? anyone", "internet slow"]);
    expect(column(r, "waits", "Charged to")).toEqual([`Bipul ${tag}`, `Rina ${tag}`]);
    const all = await run(isp, "missed", { groups: fixtureGroups(), status: "all" });
    expect(table(all, "waits").rows).toHaveLength(6);
  });

  it("Team Workload: replies and waits per person, support time equal to the Team Report's", async () => {
    const r = await run(isp, "workload", { groups: fixtureGroups() });
    const rows = Object.fromEntries(table(r, "members").rows.map((row) => [row.key, row.cells]));
    expect(rows[ids.m1]!.slice(1, 4)).toEqual([1, 3, 2]); // groups, replies, waits answered
    expect(rows[ids.m2]!.slice(1, 4)).toEqual([2, 6, 2]);
    const team = await runWithProject(isp, () => loadTeamReport(parseTeamReportFilters({ ...PERIOD, groups: fixtureGroups() }, new Date()), new Date()));
    const time = (id: string) => team.result.members.find((m) => m.memberId === id)!.activeSeconds;
    const workloadSeconds = table(r, "members").rows.find((row) => row.key === ids.m1)!.sort[4];
    expect(workloadSeconds).toBe(time(ids.m1));
    expect(time(ids.m1)).toBe(2 * 3600 + 55 * 60); // 09:10–12:05, one stretch
  });

  it("Workload Distribution: shares of the stated total", async () => {
    const r = await run(isp, "distribution", { groups: fixtureGroups(), metric: "replies" });
    expect(tile(r, "Total replies")).toBe("9");
    expect(Object.fromEntries(table(r, "shares").rows.map((row) => [row.key, row.cells[2]]))).toEqual({ [ids.m1]: "33.3%", [ids.m2]: "66.7%" });
  });

  it("Employee Support Breakdown: one row per member per group", async () => {
    const r = await run(isp, "employee-groups", { groups: fixtureGroups() });
    expect(table(r, "pairs").rows.map((row) => row.key).sort()).toEqual(
      [`${ids.m1}|${ids.wg.busy}`, `${ids.m2}|${ids.wg.busy}`, `${ids.m2}|${ids.wg.low}`].sort(),
    );
  });

  it("Duty & Workload: the overnight shift owns the hours after midnight; totals equal the Team Report", async () => {
    const r = await run(isp, "duty-workload", { groups: fixtureGroups() });
    const day = (member: string, date: string) => table(r, "days").rows.find((row) => row.key === `${member}|${date}`)!;
    const sortOf = (row: { sort: Array<string | number> }, label: string) => row.sort[table(r, "days").columns.findIndex((c) => c.label === label)];
    // Bipul, Night 22:00–06:00 on the 12th: 23:00–23:30 and 01:00–01:20 the next morning, all in shift.
    expect(sortOf(day(ids.m2, D), "Recorded in shift")).toBe(30 * 60 + 20 * 60);
    expect(sortOf(day(ids.m2, D), "Scheduled")).toBe(8 * 3600);
    expect(sortOf(day(ids.m2, D1), "Recorded in shift")).toBe(0);
    expect(sortOf(day(ids.m2, D1), "On off day")).toBe(0);
    // Rina, Day 10:00–19:00: 09:10–10:00 beyond schedule, 10:00–12:05 in shift.
    expect(sortOf(day(ids.m1, D), "Recorded in shift")).toBe(2 * 3600 + 5 * 60);
    expect(sortOf(day(ids.m1, D), "Beyond schedule")).toBe(50 * 60);
    const team = await runWithProject(isp, () => loadTeamReport(parseTeamReportFilters({ ...PERIOD, groups: fixtureGroups() }, new Date()), new Date()));
    const perMember = table(r, "members");
    const totalIndex = perMember.columns.findIndex((c) => c.label === "Recorded in total");
    for (const member of [ids.m1, ids.m2]) {
      expect(perMember.rows.find((row) => row.key === member)!.sort[totalIndex]).toBe(team.result.members.find((m) => m.memberId === member)!.activeSeconds);
    }
    expect(perMember.rows.find((row) => row.key === ids.m2)!.cells[2]).toBe(1); // one overnight shift
  });

  it("Heatmap: customer messages by Dhaka weekday and hour", async () => {
    const r = await run(isp, "heatmap", { groups: fixtureGroups() });
    const wednesday = table(r, "grid").rows.find((row) => row.key === "3")!;
    // Columns: Weekday, 00..23, Total.
    for (const hour of [9, 10, 12, 14, 15, 16]) expect(wednesday.cells[hour + 1]).toBe(1);
    expect(wednesday.cells[25]).toBe(6);
    expect(tile(r, "Customer messages")).toBe("6");
  });

  it("Group Activity Trend: per day, with the group nobody answered", async () => {
    const r = await run(isp, "group-trend", { groups: fixtureGroups(), by: "day" });
    const rows = Object.fromEntries(table(r, "buckets").rows.map((row) => [row.key, row.cells]));
    expect(rows[D]!.slice(1)).toEqual([6, 8, 4, 1, 6, 2]);
    expect(rows[D1]!.slice(1)).toEqual([0, 2, 1, 0, 0, 0]);
  });

  it("Call Activity: requests and mentions from the text, never a made-up duration", async () => {
    const r = await run(isp, "calls", { groups: fixtureGroups() });
    expect(tile(r, "Calls requested")).toBe("2");
    expect(tile(r, "Calls mentioned")).toBe("1");
    expect(new Set(column(r, "calls", "Duration"))).toEqual(new Set(["Duration unavailable"]));
    expect(new Set(column(r, "calls", "Detected from"))).toEqual(new Set(["Inferred from message text"]));
    expect(column(r, "calls", "Written by")).toEqual(expect.arrayContaining(["Customer", `Rina ${tag}`]));
  });
});

describe("filters", () => {
  it("date: the next day alone holds only Bipul's two night messages", async () => {
    const r = await runWithProject(isp, async () => (await buildReport("workload", { period: "day", date: D1, groups: fixtureGroups() }, new Date())).report);
    expect(table(r, "members").rows.map((row) => [row.key, row.cells[2]])).toEqual([[ids.m2, 2]]);
    const sla = await runWithProject(isp, async () => (await buildReport("response-sla", { period: "day", date: D1, groups: fixtureGroups() }, new Date())).report);
    expect(sla.emptyMessage).not.toBeNull();
  });

  it("team: only Rina is in the Team; group reports take the groups assigned to or answered by her", async () => {
    const workload = await run(isp, "workload", { groups: fixtureGroups(), team: ids.team });
    expect(table(workload, "members").rows.map((row) => row.key)).toEqual([ids.m1]);
    const inactive = await run(isp, "inactive-groups", { groups: fixtureGroups(), team: ids.team, status: "all" });
    expect(table(inactive, "groups").rows.map((row) => row.key).sort()).toEqual([ids.wg.busy, ids.wg.quiet].sort());
  });

  it("member: member reports narrow to that person alone, with no Team chosen", async () => {
    for (const id of ["workload", "distribution"]) {
      const r = await run(isp, id, { groups: fixtureGroups(), member: ids.m2 });
      expect(r.tables[0]!.rows.map((row) => row.key), id).toEqual([ids.m2]);
    }
    const pairs = await run(isp, "employee-groups", { groups: fixtureGroups(), member: ids.m2 });
    expect(new Set(table(pairs, "pairs").rows.map((row) => row.key.split("|")[0]))).toEqual(new Set([ids.m2]));
    const duty = await run(isp, "duty-workload", { groups: fixtureGroups(), member: ids.m1 });
    expect(new Set(table(duty, "days").rows.map((row) => row.key.split("|")[0]))).toEqual(new Set([ids.m1]));
    const heat = await run(isp, "heatmap", { groups: fixtureGroups(), member: ids.m1, metric: "replies" });
    expect(tile(heat, "Team replies")).toBe("3"); // Rina's 09:10, 11:00, 12:05 only
  });

  it("member: Bipul's missed support covers his assigned group and the groups he answered in", async () => {
    const r = await run(isp, "missed", { groups: fixtureGroups(), member: ids.m2, status: "all" });
    expect(table(r, "waits").rows).toHaveLength(5); // every wait but the second number's
  });

  it("groups: one group chosen means only its waits", async () => {
    const r = await run(isp, "response-sla", { groups: ids.wg.low });
    expect(tile(r, "Customer waits")).toBe("1");
  });

  it("account: the second number alone", async () => {
    const r = await run(isp, "response-sla", { groups: fixtureGroups(), account: ids.accounts.a2 });
    expect(tile(r, "Customer waits")).toBe("1");
    const workload = await run(isp, "workload", { groups: fixtureGroups(), account: ids.accounts.a2 });
    expect(workload.emptyMessage).not.toBeNull();
  });
});

describe("invalid and foreign filters degrade, never leak and never throw", () => {
  const HOSTILE: Array<Record<string, string>> = [
    { member: "BIZ" }, // replaced below with Bizify's real member id
    { account: "BIZ" }, // Bizify's real account id
    { team: "not-a-team" },
    { groups: "nope@g.us,also-nope,,  ,'; DROP TABLE x;--" },
    { status: "DELETE", metric: "../../etc", low: "-1" },
    { period: "bogus", date: "2025-13-45", by: "century" },
    { period: "custom", from: D1, to: D }, // reversed
    { period: "custom", from: "2020-01-01", to: "2030-12-31" }, // far past the 92-day limit
    // Names every plain object inherits: `x in obj` is true for them, so an `in` check let them through.
    { metric: "toString", status: "constructor" },
    { metric: "__proto__", status: "hasOwnProperty", low: "valueOf" },
    { team: "toString" },
    { team: "constructor", member: "BIZ" },
    // Dates JavaScript accepts and Postgres does not.
    { period: "custom", from: "9999-12-31", to: "9999-12-31" },
    { period: "day", date: "9999-12-31" },
    { period: "custom", from: "0000-01-01", to: "0000-01-02" },
  ];

  for (const params of HOSTILE) {
    it(`every report survives ${JSON.stringify(params)}`, async () => {
      const resolved = Object.fromEntries(
        Object.entries(params).map(([k, v]) => [k, v === "BIZ" ? (k === "member" ? bizIds.member : bizIds.account) : v]),
      );
      for (const id of GENERIC_REPORT_IDS) {
        const r = await run(isp, id, resolved);
        const text = JSON.stringify(r);
        for (const name of [bizGroupName, bizMemberName, "I got a missed call", "invoice please"]) expect(text, `${id} ${name}`).not.toContain(name);
      }
    });
  }

  it("Bizify's member or account, chosen in ISP Digital, selects nothing of ISP Digital's either", async () => {
    const byMember = await run(isp, "workload", { groups: fixtureGroups(), member: bizIds.member });
    expect(table(byMember, "members").rows).toHaveLength(0);
    const byAccount = await run(isp, "response-sla", { groups: fixtureGroups(), account: bizIds.account });
    expect(byAccount.emptyMessage).not.toBeNull();
  });
});

describe("the Team Report itself", () => {
  it("is unchanged when the new filters are left empty", async () => {
    const now = new Date();
    const without = await runWithProject(isp, () =>
      loadTeamReport({ period: "custom", date: D, from: D, to: D1, memberId: null, teamId: null, granularity: "day" }, now),
    );
    const withEmpty = await runWithProject(isp, () =>
      loadTeamReport({ period: "custom", date: D, from: D, to: D1, memberId: null, teamId: null, granularity: "day", groupKeys: [], accountId: null }, now),
    );
    expect(JSON.stringify(withEmpty.result)).toBe(JSON.stringify(without.result));
    expect(without.result.waits.length).toBeGreaterThanOrEqual(6);
  });

  it("narrows to the chosen groups and account", async () => {
    const now = new Date();
    const one = await runWithProject(isp, () => loadTeamReport(parseTeamReportFilters({ ...PERIOD, groups: ids.wg.busy }, now), now));
    expect(one.result.groups.map((g) => g.groupKey)).toEqual([ids.wg.busy]);
    const second = await runWithProject(isp, () => loadTeamReport(parseTeamReportFilters({ ...PERIOD, account: ids.accounts.a2 }, now), now));
    expect(second.result.groups.map((g) => g.groupKey)).toEqual([ids.wg.acc2]);
  });
});

describe("project isolation", () => {
  it("the comparison is not vacuous: ISP Digital's fixtures are in its reports", () => {
    expect(ispAfter["missed"]).toContain("hello? anyone");
    expect(ispAfter["workload"]).toContain(`Rina ${tag}`);
    expect(bizReports["calls"]).toContain("missed call");
  });

  for (const id of GENERIC_REPORT_IDS) {
    it(`${id}: ISP Digital's report does not move when Bizify fills the same group`, () => {
      expect(ispAfter[id]).toBe(ispBefore[id]);
    });
  }

  it("Bizify's reports count exactly its own rows and never name ISP Digital's", async () => {
    const text = Object.values(bizReports).join("\n");
    for (const name of [`Rina ${tag}`, `Bipul ${tag}`, `ISP busy ${tag}`, "hello? anyone", `ref ${tag}`]) expect(text).not.toContain(name);
    const sla = await run(biz, "response-sla");
    // 08:00 (answered 08:50), 13:00 (20:00 continues it; answered 21:30), and 09:00 the next day.
    expect(tile(sla, "Customer waits")).toBe("3");
    const calls = await run(biz, "calls");
    expect(tile(calls, "Missed calls mentioned")).toBe("1");
    expect(column(calls, "calls", "Duration")).toContain("0h 15m (stated in message)");
    const duty = await run(biz, "duty-workload");
    expect(table(duty, "days").rows.map((row) => row.cells[0])).toContain(bizMemberName);
  });

  it("and ISP Digital's never name Bizify's", () => {
    const text = Object.values(ispAfter).join("\n");
    for (const name of [bizGroupName, bizMemberName, "I got a missed call", "invoice please"]) expect(text).not.toContain(name);
  });
});

describe("row keys (selection and selected-row export)", () => {
  it("are unique within every table of every report", async () => {
    for (const id of GENERIC_REPORT_IDS) {
      const r = await run(isp, id, { groups: fixtureGroups(), status: "all" });
      for (const tb of r.tables) {
        const keys = tb.rows.map((row) => row.key);
        expect(new Set(keys).size, `${id}/${tb.id}`).toBe(keys.length);
      }
    }
  });

  it("name the same rows after newer data arrives (calls were keyed by position)", async () => {
    const before = await run(isp, "calls", { groups: fixtureGroups() });
    const g = await rawPrisma.whatsAppGroup.findFirstOrThrow({ where: { projectId: isp.id, whatsappGroupId: ids.wg.low } });
    const newest = await rawPrisma.message.create({
      data: {
        projectId: isp.id, accountId: g.accountId, groupId: g.id, chatId: g.whatsappGroupId, whatsappMessageId: `wamid-${randomUUID()}`,
        senderPhone: "8801999999999", direction: "INCOMING", body: "please call me again", normalizedBody: "please call me again",
        timestampWa: t(20, 0), processingStatus: "PROCESSED",
      },
    });
    try {
      const after = await run(isp, "calls", { groups: fixtureGroups() });
      const bodyOf = (r: BuiltReport, key: string) => table(r, "calls").rows.find((row) => row.key === key)?.cells[6];
      for (const row of table(before, "calls").rows) expect(bodyOf(after, row.key)).toBe(row.cells[6]);
      expect(table(after, "calls").rows).toHaveLength(table(before, "calls").rows.length + 1);
    } finally {
      await rawPrisma.message.delete({ where: { id: newest.id } });
    }
  });
});

describe("empty data and exports", () => {
  it("every report builds for a project with no data, and says it is empty", async () => {
    for (const id of GENERIC_REPORT_IDS) {
      const r = await run(empty, id);
      expect(r.emptyMessage, id).not.toBeNull();
    }
  });

  it("the Excel file has Summary, Detailed and Breakdown sheets matching the tables; CSV is the main table", async () => {
    const { report, ctx } = await runWithProject(isp, () => buildReport("response-sla", { ...PERIOD, groups: fixtureGroups() }, new Date()));
    const book = XLSX.read(reportWorkbook(report, ctx), { type: "buffer" });
    expect(book.SheetNames).toEqual(["Summary", "Detailed", "Breakdown - By who answered", "Breakdown - By day"]);
    const detailed = XLSX.utils.sheet_to_json<Record<string, unknown>>(book.Sheets["Detailed"]!);
    expect(detailed).toHaveLength(report.tables[0]!.rows.length);
    expect(Object.keys(detailed[0]!)).toEqual(tableHeader(report.tables[0]!));
    const summary = XLSX.utils.sheet_to_json<{ Item: string; Value: string }>(book.Sheets["Summary"]!);
    expect(summary.find((row) => row.Item === "Within SLA")?.Value).toContain("66.7%");
    expect(summary.some((row) => String(row.Item).startsWith("Formula: SLA %"))).toBe(true);
    const csv = toCsv(tableHeader(report.tables[0]!), tableRows(report.tables[0]!));
    expect(csv.split("\r\n")).toHaveLength(report.tables[0]!.rows.length + 1);
  });

  it("a text cell that looks like a formula is neutralised in the file", async () => {
    const rows = tableRows({ id: "x", sheet: "Detailed", title: "", description: "", noun: { singular: "", plural: "" }, columns: [{ label: "Group" }], rows: [{ key: "a", cells: ["=HYPERLINK(1)"], sort: [""] }] });
    expect(String(rows[0]![0])).not.toMatch(/^=/);
  });
});
