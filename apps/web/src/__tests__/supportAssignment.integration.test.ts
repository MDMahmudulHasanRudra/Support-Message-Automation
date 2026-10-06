import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import * as XLSX from "xlsx";
import { NextRequest } from "next/server";
import type { SupportAssignmentStatus } from "@prisma/client";
import { createProjectWithDefaults, ORIGINAL_PROJECT_ID, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Support Assignment — the dashboard side (SUPPORT_ASSIGNMENT.md): assigning (single, bulk, racing,
 * reassigning), cancelling, the settings and the import of open waits, the lists, the report and its
 * export, the login link behind "My assignments" — each behind its key, in this project only.
 * (The worker side — cases opening, completing, overdue, escalation — is apps/worker
 * supportAssignment.integration.test.ts.)
 */

let current: Session | null;
vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  requireSession: async () => {
    if (!current) throw new Error("NEXT_REDIRECT /login");
    return current;
  },
  getSession: async () => current,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/projectPaths", () => ({ projectPath: async (p: string) => `/p/isp-digital${p}`, inWorkspace: async () => false }));

const { runWithProject } = await import("@/server/projectContext");
const reads = await import("@/server/supportAssignment");
const report = await import("@/server/supportAssignmentReport");
const actions = await import("@/server/actions/supportAssignment");
const memberActions = await import("@/server/actions/teamMembers");
const { GET } = await import("@/app/p/[project]/api/support-assignment/report/export/route");

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const ISP = { id: ORIGINAL_PROJECT_ID, slug: "isp-digital", name: "ISP Digital", status: "ACTIVE" as const };
const inIsp = <T,>(fn: () => Promise<T>) => runWithProject(ISP, fn);
const pid = { projectId: ORIGINAL_PROJECT_ID };
const ids = { users: [] as string[], roles: [] as string[], accounts: [] as string[], biz: "", teams: [] as string[], members: [] as string[] };
const sessions = {} as Record<"viewer" | "assigner" | "manager" | "outsider", Session>;
const fx = {} as {
  accountA: string;
  accountB: string;
  groupA: string;
  groupA2: string; // the same WhatsApp group as account B sees it
  groupC: string;
  inactive: string;
  manager: string; // the manager notification group's WhatsApp id
  support: string;
  billing: string;
  hasan: string;
  borhan: string;
  karim: string; // Billing
  retired: string; // inactive member
  bizCase: string;
};
let savedPrimary: string | null = null;
let savedSettings: Record<string, unknown> | null = null;
let seq = 0;

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
async function user(name: string, roleId: string, access = true) {
  const u = await rawPrisma.user.create({ data: { username: `${name}_${tag}`, email: `${name}_${tag}@example.test`, name, passwordHash: "x", permissionModuleId: roleId } });
  if (access) await rawPrisma.projectAccess.create({ data: { projectId: ORIGINAL_PROJECT_ID, userId: u.id } });
  ids.users.push(u.id);
  return { userId: u.id, username: u.username, email: u.email!, name } as Session;
}
async function member(name: string, teamId: string | null, status: "ACTIVE" | "INACTIVE" = "ACTIVE") {
  const m = await rawPrisma.internalTeamMember.create({ data: { ...pid, name: `${name} ${tag}`, phoneNumber: `88017${String(Date.now() % 1e6).padStart(6, "0")}${++seq}`, role: "Support", status, teamId } });
  ids.members.push(m.id);
  return m.id;
}

/** A customer wait and its case, as the worker would have written them. */
async function openCase(groupId: string, opts: { status?: SupportAssignmentStatus; body?: string; minutesAgo?: number; projectId?: string; assignedMemberId?: string; dueInMinutes?: number } = {}) {
  const projectId = opts.projectId ?? ORIGINAL_PROJECT_ID;
  const g = await rawPrisma.whatsAppGroup.findUniqueOrThrow({ where: { id: groupId } });
  const at = new Date(Date.now() - (opts.minutesAgo ?? 10) * 60_000);
  const body = opts.body ?? "Internet nai";
  const m = await rawPrisma.message.create({
    data: { projectId, accountId: g.accountId, groupId, whatsappMessageId: randomUUID(), chatId: g.whatsappGroupId, senderPhone: "8801912340000", senderName: "Hasib", direction: "INCOMING", body, normalizedBody: body, timestampWa: at, processingStatus: "PROCESSED" },
  });
  const episode = await rawPrisma.supportResponseEpisode.create({
    // ANSWERED: a group row holds at most one UNANSWERED wait, and these tests open many cases per
    // group. Nothing on the web side reads the wait's state.
    data: { projectId, accountId: g.accountId, groupId, status: "ANSWERED", firstIncomingMessageId: m.id, firstIncomingAt: at, latestIncomingMessageId: m.id, latestIncomingAt: at },
  });
  const status = opts.status ?? "UNASSIGNED";
  const closed = ["COMPLETED", "ANSWERED_BY_OTHER", "CANCELLED"].includes(status);
  return rawPrisma.supportAssignment.create({
    data: {
      projectId,
      episodeId: episode.id,
      accountId: g.accountId,
      groupId,
      whatsappGroupId: `${g.whatsappGroupId}#${++seq}`, // one current case per group: give each its own key
      status,
      firstMessageId: status === "IGNORED" ? null : m.id,
      firstMessageAt: status === "IGNORED" ? null : at,
      ...(opts.assignedMemberId
        ? { assignedMemberId: opts.assignedMemberId, assignedAt: at, assignmentRound: 1, slaMinutes: 15, dueAt: new Date(Date.now() + (opts.dueInMinutes ?? 5) * 60_000) }
        : {}),
      closedAt: closed ? new Date() : null,
    },
  });
}
const caseRow = (id: string) => rawPrisma.supportAssignment.findUniqueOrThrow({ where: { id } });
const eventTypes = async (id: string) =>
  (await rawPrisma.supportAssignmentEvent.findMany({ where: { assignmentId: id }, orderBy: [{ at: "asc" }, { id: "asc" }] })).map((e) => e.type);
const noticesFor = (id: string) =>
  rawPrisma.notification.findMany({ where: { event: "SUPPORT_ASSIGNMENT", payload: { path: ["assignmentId"], equals: id } }, orderBy: { createdAt: "asc" } });

async function enableModule(extra: Record<string, unknown> = {}) {
  await rawPrisma.supportAssignmentSettings.upsert({
    where: { projectId: ORIGINAL_PROJECT_ID },
    update: { enabled: true, assignableTeamIds: [], managerGroupIds: [fx.manager], adminMemberIds: [], slaMinutes: 15, ...extra },
    create: { id: "global", ...pid, enabled: true, managerGroupIds: [fx.manager], ...extra },
  });
}

beforeAll(async () => {
  sessions.viewer = await user("sa_viewer", await role("SA viewer", ["support_assignment.view"]));
  sessions.assigner = await user("sa_assigner", await role("SA assigner", ["support_assignment.view", "support_assignment.assign"]));
  sessions.manager = await user("sa_manager", await role("SA manager", ["support_assignment.view", "support_assignment.assign", "support_assignment.manage", "whatsapp.manage"]));
  sessions.outsider = await user("sa_outsider", await role("SA outsider", ["support_assignment.view"]), false);

  const before = await rawPrisma.supportAssignmentSettings.findUnique({ where: { projectId: ORIGINAL_PROJECT_ID } });
  if (before) {
    const { id: _i, projectId: _p, updatedAt: _u, ...rest } = before;
    savedSettings = rest;
  }
  savedPrimary = (await rawPrisma.whatsAppAccount.findFirst({ where: { ...pid, isPrimary: true } }))?.id ?? null;
  if (savedPrimary) await rawPrisma.whatsAppAccount.update({ where: { id: savedPrimary }, data: { isPrimary: false } });

  fx.accountA = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `Primary ${tag}`, status: "CONNECTED", isPrimary: true } })).id;
  fx.accountB = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `Secondary ${tag}`, status: "CONNECTED" } })).id;
  ids.accounts.push(fx.accountA, fx.accountB);
  const wa = `1203633${Date.now()}@g.us`;
  fx.groupA = (await rawPrisma.whatsAppGroup.create({ data: { ...pid, accountId: fx.accountA, whatsappGroupId: wa, name: `ABC Broadband ${tag}`, isActive: true } })).id;
  fx.groupA2 = (await rawPrisma.whatsAppGroup.create({ data: { ...pid, accountId: fx.accountB, whatsappGroupId: wa, name: `ABC Broadband ${tag}`, isActive: true } })).id;
  fx.groupC = (await rawPrisma.whatsAppGroup.create({ data: { ...pid, accountId: fx.accountA, whatsappGroupId: `fiber-${tag}@g.us`, name: `Fibernet ${tag}`, isActive: true } })).id;
  fx.inactive = (await rawPrisma.whatsAppGroup.create({ data: { ...pid, accountId: fx.accountA, whatsappGroupId: `left-${tag}@g.us`, name: `Left ${tag}`, isActive: false } })).id;
  fx.manager = `mgr-${tag}@g.us`;
  await rawPrisma.whatsAppGroup.create({ data: { ...pid, accountId: fx.accountA, whatsappGroupId: fx.manager, name: `Support Management ${tag}`, isActive: true } });
  fx.support = (await rawPrisma.team.create({ data: { ...pid, name: `Support ${tag}` } })).id;
  fx.billing = (await rawPrisma.team.create({ data: { ...pid, name: `Billing ${tag}` } })).id;
  ids.teams.push(fx.support, fx.billing);
  fx.hasan = await member("Hasan", fx.support);
  fx.borhan = await member("Borhan", fx.support);
  fx.karim = await member("Karim", fx.billing);
  fx.retired = await member("Retired", fx.support, "INACTIVE");

  const biz = await createProjectWithDefaults({ name: `SA Biz ${tag}`, slug: `sa-biz-${tag}`, status: "ACTIVE", creatorUserId: ids.users[0]! }, rawPrisma);
  ids.biz = biz.id;
  const bizAccount = await rawPrisma.whatsAppAccount.create({ data: { projectId: biz.id, label: `Biz ${tag}`, status: "CONNECTED" } });
  const bizGroup = await rawPrisma.whatsAppGroup.create({ data: { projectId: biz.id, accountId: bizAccount.id, whatsappGroupId: wa, name: `ABC Broadband ${tag}`, isActive: true } });
  fx.bizCase = (await openCase(bizGroup.id, { projectId: biz.id, body: "biz secret" })).id;
});

beforeEach(async () => {
  current = sessions.assigner;
  await enableModule();
});

afterAll(async () => {
  await rawPrisma.notification.deleteMany({ where: { accountId: { in: ids.accounts } } });
  await rawPrisma.whatsAppAccount.deleteMany({ where: { id: { in: ids.accounts } } });
  await rawPrisma.teamMembership.deleteMany({ where: { teamId: { in: ids.teams } } });
  await rawPrisma.internalTeamMember.deleteMany({ where: { id: { in: ids.members } } });
  await rawPrisma.team.deleteMany({ where: { id: { in: ids.teams } } });
  const tables = (
    await rawPrisma.$queryRaw<Array<{ table_name: string }>>`SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`
  ).map((row) => row.table_name);
  for (let pass = 0; pass < 4; pass++) {
    for (const t of tables) await rawPrisma.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "projectId" = $1`, ids.biz).catch(() => undefined);
  }
  await rawPrisma.project.deleteMany({ where: { id: ids.biz } });
  if (savedSettings) await rawPrisma.supportAssignmentSettings.update({ where: { projectId: ORIGINAL_PROJECT_ID }, data: savedSettings });
  else await rawPrisma.supportAssignmentSettings.deleteMany({ where: pid });
  if (savedPrimary) await rawPrisma.whatsAppAccount.update({ where: { id: savedPrimary }, data: { isPrimary: true } }).catch(() => undefined);
  await rawPrisma.projectAccess.deleteMany({ where: { userId: { in: ids.users } } });
  await rawPrisma.systemLog.deleteMany({ where: { actorUserId: { in: ids.users } } });
  await rawPrisma.user.deleteMany({ where: { id: { in: ids.users } } });
  await rawPrisma.permissionModule.deleteMany({ where: { id: { in: ids.roles } } });
  await rawPrisma.$disconnect();
});

describe("assigning", () => {
  it("is refused without support_assignment.assign, and while the module is off", async () => {
    const c = await openCase(fx.groupA);
    current = sessions.viewer;
    expect((await inIsp(() => actions.assignSupportCases({ ids: [c.id], memberId: fx.hasan }))).error).toBeTruthy();
    current = sessions.assigner;
    await enableModule({ enabled: false });
    expect((await inIsp(() => actions.assignSupportCases({ ids: [c.id], memberId: fx.hasan }))).error).toMatch(/switched off/);
    expect((await caseRow(c.id)).status).toBe("UNASSIGNED");
  });

  it("assigns with a deadline from the SLA, records who did it, and queues the employee's WhatsApp message", async () => {
    const c = await openCase(fx.groupA);
    const before = Date.now();
    const result = await inIsp(() => actions.assignSupportCases({ ids: [c.id], memberId: fx.hasan }));
    expect(result).toMatchObject({ assigned: 1, reassigned: 0, skipped: [], notifySkipped: 0 });
    const row = await caseRow(c.id);
    expect(row).toMatchObject({ status: "ASSIGNED", assignedMemberId: fx.hasan, assignedByUserId: sessions.assigner.userId, assignmentRound: 1, slaMinutes: 15 });
    expect(row.dueAt!.getTime() - row.assignedAt!.getTime()).toBe(15 * 60_000);
    expect(row.assignedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    const hasan = await rawPrisma.internalTeamMember.findUniqueOrThrow({ where: { id: fx.hasan } });
    const [n] = await noticesFor(c.id);
    expect(n).toMatchObject({ destination: `${hasan.phoneNumber}@c.us`, accountId: fx.accountA, status: "PENDING" });
    expect((n!.payload as { templateKey: string }).templateKey).toBe("SUPPORT_ASSIGNMENT_ASSIGNED");
    expect(await eventTypes(c.id)).toEqual(["ASSIGNED", "NOTIFIED"]);
  });

  it("refuses an inactive member, and one outside the Teams that take assignments", async () => {
    const c = await openCase(fx.groupA);
    expect((await inIsp(() => actions.assignSupportCases({ ids: [c.id], memberId: fx.retired }))).error).toMatch(/cannot be assigned/);
    await enableModule({ assignableTeamIds: [fx.support] });
    expect((await inIsp(() => actions.assignSupportCases({ ids: [c.id], memberId: fx.karim }))).error).toMatch(/cannot be assigned/);
    expect((await caseRow(c.id)).status).toBe("UNASSIGNED");
  });

  it("two managers assigning the same case at once: exactly one wins, one history line, one message", async () => {
    const c = await openCase(fx.groupA);
    const [a, b] = await Promise.all([
      inIsp(() => actions.assignSupportCases({ ids: [c.id], memberId: fx.hasan })),
      inIsp(() => actions.assignSupportCases({ ids: [c.id], memberId: fx.borhan })),
    ]);
    expect((a.assigned ?? 0) + (b.assigned ?? 0)).toBe(1);
    expect(a.skipped!.length + b.skipped!.length).toBe(1);
    const types = await eventTypes(c.id);
    expect(types.filter((t) => t === "ASSIGNED")).toHaveLength(1);
    expect(await noticesFor(c.id)).toHaveLength(1);
  });

  it("an assigned case moves only when reassigning is chosen, keeping its history and notifying the new person", async () => {
    const c = await openCase(fx.groupA);
    await inIsp(() => actions.assignSupportCases({ ids: [c.id], memberId: fx.hasan }));
    const refused = await inIsp(() => actions.assignSupportCases({ ids: [c.id], memberId: fx.borhan }));
    expect(refused).toMatchObject({ assigned: 0, reassigned: 0 });
    expect(refused.skipped![0]!.reason).toMatch(/Already assigned to Hasan/);
    const moved = await inIsp(() => actions.assignSupportCases({ ids: [c.id], memberId: fx.borhan, reassign: true }));
    expect(moved).toMatchObject({ reassigned: 1 });
    expect(await caseRow(c.id)).toMatchObject({ status: "ASSIGNED", assignedMemberId: fx.borhan, assignmentRound: 2 });
    expect(await eventTypes(c.id)).toEqual(["ASSIGNED", "NOTIFIED", "REASSIGNED", "NOTIFIED"]);
    const keys = (await noticesFor(c.id)).map((n) => (n.payload as { templateKey: string; vars: Record<string, string> }));
    expect(keys.map((k) => k.templateKey)).toEqual(["SUPPORT_ASSIGNMENT_ASSIGNED", "SUPPORT_ASSIGNMENT_REASSIGNED"]);
    expect(keys[1]!.vars.previousEmployee).toBe(`Hasan ${tag}`);
  });

  it("bulk: assigns the open ones and reports the finished one", async () => {
    const a = await openCase(fx.groupA);
    const b = await openCase(fx.groupC);
    const done = await openCase(fx.groupC, { status: "COMPLETED" });
    const result = await inIsp(() => actions.assignSupportCases({ ids: [a.id, b.id, done.id], memberId: fx.hasan }));
    expect(result).toMatchObject({ assigned: 2 });
    expect(result.skipped).toEqual([{ groupName: `Fibernet ${tag}`, reason: "It is already finished." }]);
  });

  it("a person with only a WhatsApp id is still assigned; the unsent message is recorded, not failed", async () => {
    // A real-shaped LID: 15 digits, which would pass as a phone number if the check were missing.
    const lid = `14593877${String(Date.now() % 1e7).padStart(7, "0")}`;
    const m = await rawPrisma.internalTeamMember.create({ data: { ...pid, name: `Lid ${tag}`, phoneNumber: lid, whatsappId: lid, role: "Support" } });
    ids.members.push(m.id);
    const c = await openCase(fx.groupA);
    const result = await inIsp(() => actions.assignSupportCases({ ids: [c.id], memberId: m.id }));
    expect(result).toMatchObject({ assigned: 1, notifySkipped: 1 });
    expect(await noticesFor(c.id)).toHaveLength(0);
    expect(await eventTypes(c.id)).toEqual(["ASSIGNED", "NOTIFY_SKIPPED"]);
  });
});

describe("cancelling", () => {
  it("closes open cases with the reason and leaves finished ones alone", async () => {
    const open = await openCase(fx.groupA);
    const done = await openCase(fx.groupC, { status: "COMPLETED" });
    const result = await inIsp(() => actions.cancelSupportCases({ ids: [open.id, done.id], reason: "Not a support question" }));
    expect(result).toMatchObject({ cancelled: 1, skipped: 1 });
    expect(await caseRow(open.id)).toMatchObject({ status: "CANCELLED", closeReason: "Not a support question" });
    expect((await caseRow(done.id)).status).toBe("COMPLETED");
    expect(await eventTypes(done.id)).not.toContain("CANCELLED");
  });

  it("another project's case cannot be touched by id", async () => {
    const result = await inIsp(() => actions.cancelSupportCases({ ids: [fx.bizCase] }));
    expect(result.cancelled).toBe(0);
    expect((await caseRow(fx.bizCase)).status).toBe("UNASSIGNED");
  });
});

describe("lists", () => {
  it("each view selects its cases, never a group the account has left, never another project's", async () => {
    const lena = await member("Lena", fx.support);
    const omar = await member("Omar", fx.support);
    const unassigned = await openCase(fx.groupA);
    const assigned = await openCase(fx.groupC, { status: "ASSIGNED", assignedMemberId: lena });
    const overdue = await openCase(fx.groupC, { status: "OVERDUE", assignedMemberId: omar, dueInMinutes: -5 });
    const left = await openCase(fx.inactive);
    const ignored = await openCase(fx.groupA, { status: "IGNORED" });
    const idsOf = async (view: Parameters<typeof reads.parseAssignmentFilters>[1], params: Record<string, string> = {}, mine: string | null = null) =>
      (await inIsp(() => reads.listAssignments(reads.parseAssignmentFilters({ q: tag, ...params }, view), 1, 500, mine))).rows.map((r) => r.id);

    const all = await idsOf("all");
    expect(all).toEqual(expect.arrayContaining([unassigned.id, assigned.id, overdue.id]));
    expect(all).not.toContain(left.id);
    expect(all).not.toContain(ignored.id);
    expect(all).not.toContain(fx.bizCase);
    expect(await idsOf("unassigned")).not.toContain(assigned.id);
    expect(await idsOf("overdue")).toEqual(expect.arrayContaining([overdue.id]));
    expect(await idsOf("overdue")).not.toContain(assigned.id);
    expect(await idsOf("mine", {}, lena)).toEqual([assigned.id]);
    expect(await idsOf("mine", {}, null)).toEqual([]);
    expect(await idsOf("closed", { status: "IGNORED" })).toEqual(expect.arrayContaining([ignored.id]));
    expect(await idsOf("all", { memberId: omar })).toEqual([overdue.id]);
  });
});

describe("settings", () => {
  const form = (entries: Array<[string, string]>) => {
    const fd = new FormData();
    for (const [k, v] of entries) fd.append(k, v);
    return fd;
  };

  it("needs support_assignment.manage, and refuses a Team from another project", async () => {
    current = sessions.assigner;
    expect((await inIsp(() => actions.saveSupportAssignmentSettings({}, form([["enabled", "on"]])))).error).toBeTruthy();
    current = sessions.manager;
    const bizTeam = await rawPrisma.team.create({ data: { projectId: ids.biz, name: `Biz team ${tag}` } });
    const result = await inIsp(() => actions.saveSupportAssignmentSettings({}, form([["enabled", "on"], ["assignableTeamIds", bizTeam.id]])));
    expect(result.error).toMatch(/not in this project/);
  });

  it("cleans and clamps what is typed", async () => {
    current = sessions.manager;
    await inIsp(() =>
      actions.saveSupportAssignmentSettings(
        {},
        form([
          ["enabled", "on"],
          ["slaMinutes", "0"],
          ["escalationAfterMinutes", "99999"],
          ["ignoredKeywords", "  Thanks \nTHANKS\n\nThank   You"],
          ["ignoredSenders", "+880 1711-000000"],
          ["managerGroupIds", fx.manager],
        ]),
      ),
    );
    const s = await rawPrisma.supportAssignmentSettings.findUniqueOrThrow({ where: { projectId: ORIGINAL_PROJECT_ID } });
    expect(s).toMatchObject({ slaMinutes: 1, escalationAfterMinutes: 1440, ignoredKeywords: ["thanks", "thank you"], ignoredSenders: ["8801711000000"], managerGroupIds: [fx.manager] });
  });

  it("switching it on brings in open waits once — one case per WhatsApp group across accounts, ignored ones as IGNORED", async () => {
    current = sessions.manager;
    await enableModule({ enabled: false });
    const g = await rawPrisma.whatsAppGroup.findUniqueOrThrow({ where: { id: fx.groupA } });
    const at = new Date(Date.now() - 30 * 60_000);
    const waits: string[] = [];
    for (const [groupId, accountId, body] of [
      [fx.groupA, fx.accountA, "Router kaj kortese na"],
      [fx.groupA2, fx.accountB, "Router kaj kortese na"],
    ] as const) {
      const m = await rawPrisma.message.create({
        data: { ...pid, accountId, groupId, whatsappMessageId: randomUUID(), chatId: g.whatsappGroupId, senderPhone: "8801912340000", direction: "INCOMING", body, normalizedBody: body, timestampWa: at, processingStatus: "PROCESSED" },
      });
      waits.push((await rawPrisma.supportResponseEpisode.create({ data: { ...pid, accountId, groupId, firstIncomingMessageId: m.id, firstIncomingAt: at, latestIncomingMessageId: m.id, latestIncomingAt: at } })).id);
    }
    const thanksGroup = await rawPrisma.whatsAppGroup.create({ data: { ...pid, accountId: fx.accountA, whatsappGroupId: `thanks-${tag}@g.us`, name: `Thanks ${tag}`, isActive: true } });
    const tm = await rawPrisma.message.create({
      data: { ...pid, accountId: fx.accountA, groupId: thanksGroup.id, whatsappMessageId: randomUUID(), chatId: thanksGroup.whatsappGroupId, senderPhone: "8801912340000", direction: "INCOMING", body: "Thank you ভাই", normalizedBody: "Thank you ভাই", timestampWa: at, processingStatus: "PROCESSED" },
    });
    await rawPrisma.supportResponseEpisode.create({ data: { ...pid, accountId: fx.accountA, groupId: thanksGroup.id, firstIncomingMessageId: tm.id, firstIncomingAt: at, latestIncomingMessageId: tm.id, latestIncomingAt: at } });

    const on = form([["enabled", "on"], ["ignoredKeywords", "thank you\nthanks"]]);
    const first = await inIsp(() => actions.saveSupportAssignmentSettings({}, on));
    expect(first.saved).toBe(true);
    expect(first.imported).toBeGreaterThanOrEqual(2);
    const routerCases = await rawPrisma.supportAssignment.findMany({ where: { whatsappGroupId: g.whatsappGroupId, closedAt: null } });
    expect(routerCases).toHaveLength(1);
    expect(routerCases[0]!.status).toBe("UNASSIGNED");
    expect(await rawPrisma.supportAssignment.findFirst({ where: { groupId: thanksGroup.id } })).toMatchObject({ status: "IGNORED" });

    // Saving again (already on) imports nothing.
    const again = await inIsp(() => actions.saveSupportAssignmentSettings({}, on));
    expect(again.imported).toBe(0);
    expect(await rawPrisma.supportAssignment.count({ where: { whatsappGroupId: g.whatsappGroupId } })).toBe(1);
    // Neither does switching off and on while the case is still current.
    await inIsp(() => actions.saveSupportAssignmentSettings({}, form([["ignoredKeywords", "thanks"]])));
    await inIsp(() => actions.saveSupportAssignmentSettings({}, on));
    expect(await rawPrisma.supportAssignment.count({ where: { whatsappGroupId: g.whatsappGroupId } })).toBe(1);
    // A cancelled case stays cancelled: saving the (already on) settings never brings its wait back.
    // Only the customer's next message opens a new case.
    current = sessions.assigner;
    await inIsp(() => actions.cancelSupportCases({ ids: [routerCases[0]!.id] }));
    current = sessions.manager;
    expect((await inIsp(() => actions.saveSupportAssignmentSettings({}, on))).imported).toBe(0);
    expect(await rawPrisma.supportAssignment.count({ where: { whatsappGroupId: g.whatsappGroupId } })).toBe(1);
  });
});

describe("report", () => {
  it("counts the period's cases the same on the page and in the Excel file", async () => {
    const tagGroup = await rawPrisma.whatsAppGroup.create({ data: { ...pid, accountId: fx.accountA, whatsappGroupId: `rep-${tag}@g.us`, name: `Report ${tag}`, isActive: true } });
    const done = await openCase(tagGroup.id, { status: "COMPLETED", assignedMemberId: fx.hasan, minutesAgo: 30 });
    await rawPrisma.supportAssignment.update({ where: { id: done.id }, data: { completedAt: new Date(), responseSeconds: 420, responderMemberId: fx.hasan, dueAt: new Date(Date.now() + 60_000) } });
    await rawPrisma.supportAssignmentEvent.create({ data: { ...pid, assignmentId: done.id, type: "ASSIGNED", memberId: fx.hasan } });
    await openCase(tagGroup.id, { status: "OVERDUE", assignedMemberId: fx.hasan, dueInMinutes: -10 });
    await openCase(tagGroup.id, { status: "IGNORED" });
    await openCase(tagGroup.id);

    const params = { preset: "today", group: `Report ${tag}` };
    const filters = report.parseReportFilters(params, new Date());
    const { report: r, cases } = await inIsp(() => report.loadSupportAssignmentReport(filters));
    expect(r.summary).toMatchObject({ total: 3, ignored: 1, unassigned: 1, completed: 1, pending: 1, avgResponseSeconds: 420 });
    expect(r.summary.sla).toEqual({ met: 1, measured: 2 });
    expect(cases).toHaveLength(4);

    const res = await inIsp(() => GET(new NextRequest(`http://localhost/p/isp-digital/api/support-assignment/report/export?${new URLSearchParams({ ...params, format: "xlsx" })}`)));
    const book = XLSX.read(new Uint8Array(await res.arrayBuffer()), { type: "array" });
    expect(book.SheetNames).toEqual(["Summary", "Employees", "Groups", "Cases"]);
    const summary = XLSX.utils.sheet_to_json<{ Figure: string; Value: unknown }>(book.Sheets.Summary!);
    expect(summary.find((row) => row.Figure === "Support cases")?.Value).toBe(3);
    expect(XLSX.utils.sheet_to_json(book.Sheets.Cases!)).toHaveLength(4);

    const csv = await inIsp(() => GET(new NextRequest(`http://localhost/p/isp-digital/api/support-assignment/report/export?${new URLSearchParams({ ...params, format: "csv" })}`)));
    expect((await csv.text()).trim().split("\r\n")).toHaveLength(5);
  });

  it("the export is refused without support_assignment.view", async () => {
    current = null;
    await expect(inIsp(() => GET(new NextRequest("http://localhost/p/isp-digital/api/support-assignment/report/export?format=csv")))).rejects.toThrow();
  });
});

describe("login link (My assignments)", () => {
  it("links a login that can enter the project, once per project", async () => {
    current = sessions.manager;
    const fd = (userId: string) => {
      const f = new FormData();
      f.set("userId", userId);
      return f;
    };
    expect((await inIsp(() => memberActions.linkTeamMemberLogin(fx.hasan, {}, fd(sessions.outsider.userId)))).error).toMatch(/cannot enter this project/);
    expect(await inIsp(() => memberActions.linkTeamMemberLogin(fx.hasan, {}, fd(sessions.viewer.userId)))).toEqual({ saved: true });
    expect((await inIsp(() => memberActions.linkTeamMemberLogin(fx.borhan, {}, fd(sessions.viewer.userId)))).error).toMatch(/already linked to Hasan/);
    expect((await inIsp(() => reads.getMemberForUser(sessions.viewer.userId)))?.id).toBe(fx.hasan);
    expect(await inIsp(() => memberActions.linkTeamMemberLogin(fx.hasan, {}, fd("")))).toEqual({ saved: true });
    expect(await inIsp(() => reads.getMemberForUser(sessions.viewer.userId))).toBeNull();
  });
});
