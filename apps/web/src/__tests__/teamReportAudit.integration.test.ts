import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import * as XLSX from "xlsx";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import type { Session } from "@/server/auth";

/**
 * Team Report audit (19 Oct 2026, Phase A), against real rows:
 *  - after a group is reassigned, every report and the Excel file charge an earlier Missed wait to
 *    whoever was assigned when the customer asked — never today's assignee;
 *  - assignment history is the group's as the report reads it (all our numbers' copies merged), so a
 *    second number's unassigned copy never charges a wait to "Unassigned";
 *  - a wait is judged by the threshold in force when the customer asked, in the Team Report and in
 *    the human-response measure alike;
 *  - with one account chosen, who sent a message is still decided from every account's copies;
 *  - a dashboard reply is not credited before the member's "count their messages from" date, and a
 *    template test send is never anybody's reply;
 *  - editing a member's name leaves their default shift on the days before;
 *  - the CSV export opens in Excel as UTF-8, with a header even when empty.
 */

let current: Session;
const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const D = "2025-07-08";
const t = (hh: number, mm: number) => new Date(Date.UTC(2025, 6, 8, hh - 6, mm));
const nine = () => String(Math.floor(Math.random() * 1e9)).padStart(9, "0");
const phone = () => `88017${nine().slice(1)}`;
const wa = (n: number) => `120380${Date.now()}${n}${Math.floor(Math.random() * 1000)}@g.us`;
const G = [wa(0), wa(1), wa(2), wa(3)];
const lid = () => `${Math.floor(1e14 + Math.random() * 8e14)}`;

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
const { loadTeamReport, parseTeamReportFilters } = await import("@/server/teamReport");
const { buildReport } = await import("@/server/reports");
const { setGroupPriority } = await import("@/server/actions/groups");
const exportRoute = await import("@/app/p/[project]/api/team-report/export/route");

const ids = { user: "", project: "", slug: "", primary: "", second: "", rows: {} as Record<string, { A: string; B?: string }>, rakib: "", bipul: "", rina: "", nadia: "", late: "", shift: "" };
const people = { customer: lid(), rinaPhone: phone(), nadiaLid: lid(), nadiaPhone: phone() };
const project = () => ({ id: ids.project, slug: ids.slug, name: `Audit ${tag}`, status: "ACTIVE" as const });
const inProject = <T,>(fn: () => Promise<T>) => runWithProject(project(), fn);
const report = (extra: Record<string, string> = {}) =>
  inProject(() => loadTeamReport(parseTeamReportFilters({ period: "day", date: D, ...extra }, new Date()), new Date()));

async function message(chat: string, row: "A" | "B", key: string, sender: string, jid: string | null, at: Date, direction: "INCOMING" | "OUTGOING" = "INCOMING", fromMe = false) {
  return rawPrisma.message.create({
    data: {
      projectId: ids.project,
      accountId: row === "A" ? ids.primary : ids.second,
      groupId: row === "A" ? ids.rows[chat]!.A : ids.rows[chat]!.B!,
      chatId: chat,
      whatsappMessageId: `${fromMe ? "true" : "false"}_${chat}_${key}${tag}_${jid ?? sender}`,
      senderPhone: sender,
      senderJid: jid,
      direction,
      body: "text",
      normalizedBody: "text",
      timestampWa: at,
      processingStatus: "PROCESSED",
    },
    select: { whatsappMessageId: true },
  });
}

beforeAll(async () => {
  const u = await rawPrisma.user.create({ data: { username: `audit_${tag}`, email: `audit_${tag}@example.test`, name: "Audit", passwordHash: "x" } });
  ids.user = u.id;
  current = { userId: u.id, username: u.username, email: u.email!, name: "Audit" } as Session;
  const created = await createProjectWithDefaults({ name: `Audit ${tag}`, slug: `audit-${tag}`, status: "ACTIVE", creatorUserId: u.id }, rawPrisma);
  ids.project = created.id;
  ids.slug = created.slug;
  const pid = { projectId: created.id };
  ids.primary = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `Audit A ${tag}`, status: "CONNECTED", isPrimary: true } })).id;
  ids.second = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `Audit B ${tag}`, status: "CONNECTED" } })).id;
  ids.rakib = (await rawPrisma.internalTeamMember.create({ data: { ...pid, name: `Rakib ${tag}`, phoneNumber: `+${phone()}`, role: "Support" } })).id;
  ids.bipul = (await rawPrisma.internalTeamMember.create({ data: { ...pid, name: `Bipul ${tag}`, phoneNumber: `+${phone()}`, role: "Support" } })).id;
  ids.rina = (await rawPrisma.internalTeamMember.create({ data: { ...pid, name: `Rina ${tag}`, phoneNumber: `+${people.rinaPhone}`, role: "Support" } })).id;
  ids.nadia = (await rawPrisma.internalTeamMember.create({ data: { ...pid, name: `Nadia ${tag}`, phoneNumber: `+${people.nadiaPhone}`, role: "Support" } })).id;
  // A member whose login sent dashboard replies, counted only from a date after D.
  ids.late = (
    await rawPrisma.internalTeamMember.create({
      data: { ...pid, name: `Late ${tag}`, phoneNumber: `+${phone()}`, role: "Support", userId: u.id, attributeFrom: new Date(Date.UTC(2025, 6, 20)) },
    })
  ).id;
  await rawPrisma.supportPriorityPolicy.upsert({
    where: { projectId_priority: { projectId: created.id, priority: "P1" } },
    create: { ...pid, priority: "P1", firstAlertMinutes: 10, secondAlertMinutes: 20, memberEscalationMinutes: 30, adminEscalationMinutes: 40, followUpIntervalMinutes: 60, maxEscalations: 3 },
    update: { firstAlertMinutes: 10 },
  });

  // G0: Rakib's on the Primary copy (P1, 10 min); the second number's copy unassigned. The customer
  // asks at 09:00, Rina answers 20 minutes later (late against 10); asked again at 11:00, nobody answers.
  const row = (accountId: string, chat: string, extra: Record<string, unknown> = {}) =>
    rawPrisma.whatsAppGroup.create({
      data: { ...pid, accountId, whatsappGroupId: chat, name: `Audit ${chat.slice(-8)} ${tag}`, isMonitored: true, isActive: true, lastSyncedAt: new Date(), ...extra },
      select: { id: true },
    });
  ids.rows[G[0]!] = { A: (await row(ids.primary, G[0]!, { assignedTeamMemberId: ids.rakib, priority: "P1" })).id, B: (await row(ids.second, G[0]!)).id };
  await message(G[0]!, "A", "Q1", people.customer, `${people.customer}@lid`, t(9, 0));
  await message(G[0]!, "A", "R1", people.rinaPhone, `${people.rinaPhone}@c.us`, t(9, 20));
  await message(G[0]!, "A", "Q2", people.customer, `${people.customer}@lid`, t(11, 0));

  // G1: Nadia (on file by phone) answers; the Primary stored her LID, the second number her phone.
  ids.rows[G[1]!] = { A: (await row(ids.primary, G[1]!)).id, B: (await row(ids.second, G[1]!)).id };
  await message(G[1]!, "A", "Q", people.customer, `${people.customer}@lid`, t(10, 0));
  await message(G[1]!, "B", "Q", people.customer, `${people.customer}@lid`, t(10, 0));
  await message(G[1]!, "A", "N", people.nadiaLid, `${people.nadiaLid}@lid`, t(10, 5));
  await message(G[1]!, "B", "N", people.nadiaPhone, `${people.nadiaPhone}@c.us`, t(10, 5));

  // G2: a dashboard reply from Late's login before Late's date, and a template test send.
  ids.rows[G[2]!] = { A: (await row(ids.primary, G[2]!)).id };
  await message(G[2]!, "A", "Q", people.customer, `${people.customer}@lid`, t(12, 0));
  const op = await message(G[2]!, "A", "OP", "177700000000001", "177700000000001@lid", t(12, 5), "OUTGOING", true);
  const test = await message(G[2]!, "A", "TT", "177700000000001", "177700000000001@lid", t(12, 10), "OUTGOING", true);
  for (const [m, key] of [[op, `audit-op-${tag}`], [test, `template-test:AI_HANDOVER:${ids.rows[G[2]!]!.A}:${tag}`]] as const) {
    await rawPrisma.outboundMessage.create({
      data: { ...pid, accountId: ids.primary, chatId: G[2]!, toPhone: G[2]!, body: "text", actionType: "MANUAL_REPLY", idempotencyKey: key, status: "SENT", sentAt: t(12, 5), providerMessageId: m.whatsappMessageId, createdById: u.id },
    });
  }

  // G3: Rina works there all day with a default shift set long before D.
  ids.rows[G[3]!] = { A: (await row(ids.primary, G[3]!)).id };
  ids.shift = (await rawPrisma.shiftTemplate.create({ data: { ...pid, name: `Audit shift ${tag}`, startMinute: 9 * 60, endMinute: 17 * 60 } })).id;
  await rawPrisma.shiftTemplate.update({ where: { id: ids.shift }, data: { updatedAt: new Date(Date.UTC(2025, 0, 1)) } });
  await rawPrisma.internalTeamMember.update({ where: { id: ids.rina }, data: { defaultShiftTemplateId: ids.shift, defaultShiftChangedAt: new Date(Date.UTC(2025, 0, 1)) } });
  for (let h = 9; h <= 18; h++) await message(G[3]!, "A", `W${h}`, people.rinaPhone, `${people.rinaPhone}@c.us`, t(h, 0));
}, 120_000);

afterAll(async () => {
  const tables = (
    await rawPrisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`
  ).map((r) => r.table_name);
  for (let pass = 0; pass < 6; pass++) {
    for (const name of tables) await rawPrisma.$executeRawUnsafe(`DELETE FROM "${name}" WHERE "projectId" = $1`, ids.project).catch(() => undefined);
  }
  await rawPrisma.projectAccess.deleteMany({ where: { userId: ids.user } });
  await rawPrisma.project.deleteMany({ where: { id: ids.project } });
  await rawPrisma.user.deleteMany({ where: { id: ids.user } });
  await rawPrisma.$disconnect();
});

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

describe("after a group is reassigned and its priority removed", () => {
  it("records the group's own reading: the second number's unassigned copy changes nothing", async () => {
    await inProject(() => setGroupPriority(ids.rows[G[0]!]!.B!, form({ priority: "", assignedTeamMemberId: ids.bipul })));
    expect(await rawPrisma.groupResponsibilityChange.count({ where: { projectId: ids.project } })).toBe(0);
    await inProject(() => setGroupPriority(ids.rows[G[0]!]!.A, form({ priority: "", assignedTeamMemberId: ids.bipul })));
    const changes = await rawPrisma.groupResponsibilityChange.findMany({ where: { projectId: ids.project } });
    expect(changes).toEqual([expect.objectContaining({ previousAssignedTeamMemberId: ids.rakib, previousPriority: "P1", assignedTeamMemberId: ids.bipul, priority: null })]);
  });

  it("charges the earlier Missed wait to Rakib, and judges both waits by the 10-minute P1 threshold then", async () => {
    const data = await report({ groups: G[0]! });
    const waits = data.result.waits;
    expect(waits.map((w) => [w.chargedTo, w.status, w.thresholdSeconds])).toEqual([
      [ids.rakib, "RECALLED", 600],
      [ids.rakib, "MISSED", 600],
    ]);
    expect(data.missedAfterMs(G[0]!, t(9, 0).getTime())).toBe(600_000);
  });

  it("says Rakib in Missed Support and in the Excel file", async () => {
    const built = await inProject(async () => (await buildReport("missed", { period: "day", date: D, groups: G[0]!, status: "all" }, new Date())).report);
    const charged = built.tables.find((tb) => tb.id === "waits")!.rows.map((r) => r.cells[8]);
    expect(charged).toEqual([`Rakib ${tag}`, `Rakib ${tag}`]);

    const res = await inProject(() => exportRoute.GET(new NextRequest(`http://localhost/p/${ids.slug}/api/team-report/export?period=day&date=${D}&groups=${G[0]!}&format=xlsx`)));
    const book = XLSX.read(Buffer.from(await res.arrayBuffer()), { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json<Record<string, string>>(book.Sheets["Missed & Recall"]!);
    expect(rows.map((r) => r["Charged to"])).toEqual([`Rakib ${tag}`, `Rakib ${tag}`]);
    const summary = XLSX.utils.sheet_to_json<Record<string, string>>(book.Sheets.Summary!);
    expect(summary.some((r) => r.Metric === "Data health")).toBe(true);
  });
});

describe("one account chosen", () => {
  it("still recognises the colleague the other account's copy identifies", async () => {
    const data = await report({ groups: G[1]!, account: ids.primary });
    expect(data.result.members.find((m) => m.memberId === ids.nadia)?.messages).toBe(1);
    expect(data.result.summary.customerMessages).toBe(1);
  });
});

describe("dashboard replies", () => {
  it("are not credited before the member's 'count their messages from' date, and a template test is nobody's", async () => {
    const data = await report({ groups: G[2]! });
    expect(data.result.members.find((m) => m.memberId === ids.late)).toBeUndefined();
    expect(data.result.summary.businessReplies).toBe(2);
  });
});

describe("Support Overtime", () => {
  it("keeps a member's default shift on past days after an unrelated edit of their record", async () => {
    const before = (await report({ groups: G[3]!, member: ids.rina })).result.overtimeDays.map((d) => d.source);
    await rawPrisma.internalTeamMember.update({ where: { id: ids.rina }, data: { name: `Rina R ${tag}` } });
    const after = (await report({ groups: G[3]!, member: ids.rina })).result.overtimeDays.map((d) => d.source);
    expect(before).toEqual(["DEFAULT_SHIFT"]);
    expect(after).toEqual(["DEFAULT_SHIFT"]);
  });
});

describe("the CSV export", () => {
  it("opens in Excel as UTF-8 and keeps its header when there is nothing to list", async () => {
    const res = await inProject(() => exportRoute.GET(new NextRequest(`http://localhost/p/${ids.slug}/api/team-report/export?period=day&date=2025-01-01&format=csv`)));
    const text = Buffer.from(await res.arrayBuffer()).toString("utf8");
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text.slice(1).split("\r\n")[0]).toMatch(/^Group,Group ID,Assigned now,/);
  });
});
