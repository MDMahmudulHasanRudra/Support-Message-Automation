import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import { runWithProject, type ActiveProject } from "@/server/projectContext";
import { loadTeamReport, parseTeamReportFilters } from "@/server/teamReport";
import { buildBucketsTable, buildMembersTable } from "@/server/teamReportTables";

/**
 * Support Overtime against real rows (TEAM_OVERTIME.md): each member's regular duty comes from the
 * roster, a day off, or — with no schedule that applied on the date — the project's default duty
 * length; the report shows overtime only. Before this, the column showed every member's whole
 * support time, so each figure below was the full working time.
 */

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const D = "2025-05-14"; // a Wednesday
/** A Dhaka wall-clock time on D. */
const t = (hh: number, mm = 0) => new Date(Date.UTC(2025, 4, 14, hh - 6, mm));
const NOW = new Date();
const WGID = `120363${Date.now()}${Math.floor(Math.random() * 1000)}@g.us`;
const phone = () => `8801${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;

let project: ActiveProject;
let userId = "";
const ids = { rostered: "", off: "", unscheduled: "", stalePattern: "" };

async function workFrom(memberPhone: string, accountId: string, groupId: string, fromHour: number, toHour: number) {
  for (let minute = fromHour * 60; minute <= toHour * 60; minute += 30) {
    await rawPrisma.message.create({
      data: {
        projectId: project.id,
        accountId,
        groupId,
        chatId: WGID,
        whatsappMessageId: `false_${WGID}_${randomUUID().replace(/-/g, "")}_${memberPhone}@c.us`,
        senderPhone: memberPhone,
        senderJid: `${memberPhone}@c.us`,
        isFromTeamMember: true,
        direction: "INCOMING",
        body: "on it",
        normalizedBody: "on it",
        timestampWa: t(Math.floor(minute / 60), minute % 60),
        processingStatus: "PROCESSED",
      },
    });
  }
}

beforeAll(async () => {
  userId = (await rawPrisma.user.create({ data: { username: `ot_${tag}`, email: `ot_${tag}@example.test`, name: "OT", passwordHash: "x" } })).id;
  const created = await createProjectWithDefaults({ name: `Overtime ${tag}`, slug: `ot-${tag}`, status: "ACTIVE", creatorUserId: userId }, rawPrisma);
  project = { id: created.id, slug: created.slug, name: `Overtime ${tag}`, status: "ACTIVE" };
  const pid = { projectId: project.id };
  // The shipped idle gap, so a message every 30 minutes is one continuous stretch.
  await rawPrisma.supportActivitySettings.updateMany({ where: { projectId: project.id }, data: { offlineAfterMinutes: 120, overtimeFallbackDutyMinutes: 480 } });

  const account = await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `OT ${tag}`, status: "CONNECTED" } });
  const group = await rawPrisma.whatsAppGroup.create({
    data: { ...pid, accountId: account.id, whatsappGroupId: WGID, name: `OT group ${tag}`, isMonitored: true, isActive: true, lastSyncedAt: new Date() },
  });
  const member = async (name: string) => {
    const p = phone();
    const m = await rawPrisma.internalTeamMember.create({ data: { ...pid, name: `${name} ${tag}`, phoneNumber: p, role: "Support" } });
    return { id: m.id, phone: p };
  };
  const rostered = await member("Rostered");
  const off = await member("Off");
  const unscheduled = await member("Unscheduled");
  const stale = await member("Stale pattern");
  ids.rostered = rostered.id;
  ids.off = off.id;
  ids.unscheduled = unscheduled.id;
  ids.stalePattern = stale.id;

  const date = new Date(`${D}T00:00:00Z`);
  // A 10:00–19:00 shift on D (9h), worked 09:00–21:00 (12h): 3h overtime.
  await rawPrisma.dutyAssignment.create({
    data: { ...pid, teamMemberId: rostered.id, dutyDate: date, status: "DUTY", shiftName: "Morning", shiftStartMinute: 600, shiftEndMinute: 1140 },
  });
  await workFrom(rostered.phone, account.id, group.id, 9, 21);
  // A day off, worked 10:00–12:00: all 2h are overtime.
  await rawPrisma.dutyAssignment.create({ data: { ...pid, teamMemberId: off.id, dutyDate: date, status: "OFF" } });
  await workFrom(off.phone, account.id, group.id, 10, 12);
  // No schedule at all, worked 09:00–19:00 (10h) against the 8h default: 2h.
  await workFrom(unscheduled.phone, account.id, group.id, 9, 19);
  // A weekly pattern for Wednesday set up AFTER D (created now): it did not apply on D, so the
  // default is used — 09:00–19:00 is 2h, not the 1h a 9h pattern would give.
  const template = await rawPrisma.shiftTemplate.create({ data: { ...pid, name: `Nine ${tag}`, startMinute: 600, endMinute: 1140 } });
  await rawPrisma.weeklyScheduleEntry.create({ data: { ...pid, teamMemberId: stale.id, weekday: 3, shiftTemplateId: template.id } });
  await workFrom(stale.phone, account.id, group.id, 9, 19);
}, 120_000);

afterAll(async () => {
  const tables = (
    await rawPrisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`
  ).map((row) => row.table_name);
  for (let pass = 0; pass < 6; pass++) {
    for (const name of tables) await rawPrisma.$executeRawUnsafe(`DELETE FROM "${name}" WHERE "projectId" = $1`, project.id).catch(() => undefined);
  }
  await rawPrisma.project.deleteMany({ where: { id: project.id } });
  await rawPrisma.user.deleteMany({ where: { id: userId } });
  await rawPrisma.$disconnect();
});

const report = () => runWithProject(project, () => loadTeamReport(parseTeamReportFilters({ period: "day", date: D }, NOW), NOW));
const H = 3600;

describe("Support Overtime on the Team Report", () => {
  it("is time beyond each member's regular duty for the day — not their whole support time", async () => {
    const data = await report();
    const ot = Object.fromEntries(data.result.members.map((m) => [m.memberId, m.overtimeSeconds]));
    expect(ot[ids.rostered]).toBe(3 * H);
    expect(ot[ids.off]).toBe(2 * H);
    expect(ot[ids.unscheduled]).toBe(2 * H);
    expect(ot[ids.stalePattern]).toBe(2 * H);
    expect(data.result.summary.overtimeSeconds).toBe(9 * H);
  });

  it("flags the member-days measured against the default duty length", async () => {
    const data = await report();
    expect(data.result.summary.unscheduledMemberDays).toBe(2);
    const sources = Object.fromEntries(data.result.overtimeDays.map((d) => [d.memberId, d.source]));
    expect(sources).toEqual({
      [ids.rostered]: "ROSTER",
      [ids.off]: "NO_DUTY",
      [ids.unscheduled]: "FALLBACK",
      [ids.stalePattern]: "FALLBACK",
    });
  });

  it("puts the same figure in the table, the by-day table and the chart's buckets", async () => {
    const data = await report();
    const members = buildMembersTable(data);
    const col = members.columns.findIndex((c) => c.label === "Support Overtime");
    const row = members.rows.find((r) => r.key === ids.rostered)!;
    expect(row.cells[col]).toBe("3h 0m");
    expect(row.sort[col]).toBe(3 * H);
    const buckets = buildBucketsTable(data);
    const bcol = buckets.columns.findIndex((c) => c.label === "Support Overtime");
    expect(buckets.rows.find((r) => r.key === D)!.sort[bcol]).toBe(9 * H);
    expect(data.result.buckets.find((b) => b.key === D)?.overtimeSeconds).toBe(9 * H);
  });

  it("states no duty length anywhere in what the tables show", async () => {
    const data = await report();
    const labels = [...buildMembersTable(data).columns, ...buildBucketsTable(data).columns].map((c) => c.label.toLowerCase());
    expect(labels.some((l) => l.includes("duty") || l.includes("scheduled") || l.includes("regular"))).toBe(false);
  });

  it("follows the configured default duty length", async () => {
    await rawPrisma.supportActivitySettings.updateMany({ where: { projectId: project.id }, data: { overtimeFallbackDutyMinutes: 540 } });
    try {
      const data = await report();
      expect(data.result.members.find((m) => m.memberId === ids.unscheduled)?.overtimeSeconds).toBe(1 * H);
    } finally {
      await rawPrisma.supportActivitySettings.updateMany({ where: { projectId: project.id }, data: { overtimeFallbackDutyMinutes: 480 } });
    }
  });
});
