import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, ORIGINAL_PROJECT_ID, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Follow-ups (FOLLOW_UPS.md; server/followUps.ts, server/actions/followUps.ts): create from a conversation or a
 * client, the conditional status moves and their append-only history, editing, the Dhaka-day buckets, the
 * reminder badge, the side panel — and every refusal: a read-only role, the feature off, another project's
 * follow-up, conversation, client, person or Team.
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
const { forgetProjectFeatureStates } = await import("@/server/projectFeatures");
const actions = await import("@/server/actions/followUps");
const server = await import("@/server/followUps");
const { loadWorkspace } = await import("@/server/inboxWorkspace");

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const ISP = { id: ORIGINAL_PROJECT_ID, slug: "isp-digital", name: "ISP Digital", status: "ACTIVE" as const };
let BIZ = { id: "", slug: `fu-biz-${tag}`, name: `FU Biz ${tag}`, status: "ACTIVE" as const };
const inIsp = <T,>(fn: () => Promise<T>) => runWithProject(ISP, fn);
const inBiz = <T,>(fn: () => Promise<T>) => runWithProject(BIZ, fn);
const ids = { users: [] as string[], roles: [] as string[], accounts: [] as string[], teams: [] as string[], clients: [] as string[], members: [] as string[] };
const s = {} as Record<"agent" | "agent2" | "viewer" | "noClients" | "bizAgent" | "bucket", Session>;
const fx = {} as { account: string; groupChat: string; bizAccount: string; bizGroupChat: string; conversation: string; team: string; bucketTeam: string; bizTeam: string; client: string; bizClient: string; outsider: string };

const WA = () => ({ kind: "whatsapp" as const, accountId: fx.account, chatId: fx.groupChat });
const errorOf = (r: object): string | undefined => ("error" in r ? (r as { error: string }).error : undefined);
/** A Dhaka wall-clock time as the instant it is. */
const dhaka = (iso: string) => new Date(`${iso}+06:00`);
const events = (id: string) => rawPrisma.followUpEvent.findMany({ where: { followUpId: id }, orderBy: { createdAt: "asc" }, select: { kind: true, fromValue: true, toValue: true, actorUserId: true } });

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
async function user(name: string, roleId: string, projects: string[]) {
  const u = await rawPrisma.user.create({ data: { username: `${name}_${tag}`, email: `${name}_${tag}@example.test`, name, passwordHash: "x", permissionModuleId: roleId } });
  for (const projectId of projects) await rawPrisma.projectAccess.create({ data: { projectId, userId: u.id } });
  ids.users.push(u.id);
  return { userId: u.id, username: u.username, email: u.email!, name } as Session;
}
async function feature(projectId: string, key: string, enabled: boolean) {
  await rawPrisma.projectFeature.upsert({ where: { projectId_key: { projectId, key } }, create: { projectId, key, enabled }, update: { enabled } });
  forgetProjectFeatureStates();
}
async function make(input: Parameters<typeof actions.createFollowUp>[0]) {
  const r = await inIsp(() => actions.createFollowUp(input));
  if ("error" in r) throw new Error(r.error);
  return r.id;
}

beforeAll(async () => {
  const pid = { projectId: ORIGINAL_PROJECT_ID };
  fx.account = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `FU ${tag}`, status: "CONNECTED" } })).id;
  fx.groupChat = `fu-${tag}@g.us`;
  await rawPrisma.whatsAppGroup.create({ data: { ...pid, accountId: fx.account, whatsappGroupId: fx.groupChat, name: `FU Customer ${tag}`, isActive: true } });
  fx.team = (await rawPrisma.team.create({ data: { ...pid, name: `FU Team ${tag}` } })).id;
  fx.bucketTeam = (await rawPrisma.team.create({ data: { ...pid, name: `FU Bucket Team ${tag}` } })).id;
  ids.teams.push(fx.bucketTeam);
  fx.client = (await rawPrisma.client.create({ data: { ...pid, code: `FU-${tag}`, name: `FU Client ${tag}` } })).id;
  ids.accounts.push(fx.account);
  ids.teams.push(fx.team);
  ids.clients.push(fx.client);

  const creator = await rawPrisma.user.create({ data: { username: `fuc_${tag}`, email: `fuc_${tag}@example.test`, name: "Creator", passwordHash: "x" } });
  ids.users.push(creator.id);
  BIZ = { ...BIZ, id: (await createProjectWithDefaults({ name: BIZ.name, slug: BIZ.slug, status: "ACTIVE", creatorUserId: creator.id }, rawPrisma)).id };
  fx.bizAccount = (await rawPrisma.whatsAppAccount.create({ data: { projectId: BIZ.id, label: `FU Biz ${tag}`, status: "CONNECTED" } })).id;
  fx.bizGroupChat = `fub-${tag}@g.us`;
  await rawPrisma.whatsAppGroup.create({ data: { projectId: BIZ.id, accountId: fx.bizAccount, whatsappGroupId: fx.bizGroupChat, name: `Biz group ${tag}`, isActive: true } });
  fx.bizTeam = (await rawPrisma.team.create({ data: { projectId: BIZ.id, name: `Biz Team ${tag}` } })).id;
  fx.bizClient = (await rawPrisma.client.create({ data: { projectId: BIZ.id, code: `FUB-${tag}`, name: `Biz Client ${tag}` } })).id;
  ids.accounts.push(fx.bizAccount);
  const connection = (await rawPrisma.channelConnection.create({ data: { projectId: BIZ.id, type: "TELEGRAM", name: "@fu", status: "CONNECTED", webhookKey: `fuw-${tag}` } })).id;
  fx.conversation = (await rawPrisma.channelConversation.create({ data: { projectId: BIZ.id, connectionId: connection, type: "TELEGRAM", externalThreadId: `t-${tag}` } })).id;

  const agent = await role("FU agent", ["messages.view", "messages.reply", "conversations.reply", "clients.view"]);
  const viewer = await role("FU viewer", ["messages.view"]);
  const noClients = await role("FU no clients", ["messages.view", "messages.reply", "conversations.reply"]);
  s.agent = await user("fu_agent", agent, [ORIGINAL_PROJECT_ID]);
  s.agent2 = await user("fu_agent2", agent, [ORIGINAL_PROJECT_ID]);
  s.viewer = await user("fu_viewer", viewer, [ORIGINAL_PROJECT_ID]);
  s.noClients = await user("fu_noclients", noClients, [ORIGINAL_PROJECT_ID]);
  s.bizAgent = await user("fu_bizagent", agent, [BIZ.id]);
  fx.outsider = (await user("fu_outsider", agent, [BIZ.id])).userId;
  s.bucket = await user("fu_bucket", agent, [ORIGINAL_PROJECT_ID]);
  // fu_bucket is on its Team through their roster member, so that Team's unassigned follow-ups are theirs too.
  const member = await rawPrisma.internalTeamMember.create({
    data: { ...pid, name: "FU Bucket", role: "Agent", phoneNumber: `8801${Date.now().toString().slice(-9)}`, userId: s.bucket.userId, teamId: fx.bucketTeam },
  });
  ids.members.push(member.id);
});

beforeEach(async () => {
  await feature(ORIGINAL_PROJECT_ID, "FOLLOW_UPS", true);
  await feature(ORIGINAL_PROJECT_ID, "CLIENT_CENTER", true);
  await feature(BIZ.id, "FOLLOW_UPS", true);
  await feature(BIZ.id, "OMNICHANNEL", true);
  await feature(BIZ.id, "CLIENT_CENTER", true);
  current = s.agent;
});

afterAll(async () => {
  await rawPrisma.followUp.deleteMany({ where: { OR: [{ createdById: { in: ids.users } }, { projectId: BIZ.id }, { accountId: { in: ids.accounts } }, { title: { contains: tag } }] } });
  await rawPrisma.internalTeamMember.deleteMany({ where: { id: { in: ids.members } } });
  await rawPrisma.client.deleteMany({ where: { id: { in: ids.clients } } });
  await rawPrisma.whatsAppAccount.deleteMany({ where: { id: { in: ids.accounts } } });
  await rawPrisma.team.deleteMany({ where: { id: { in: ids.teams } } });
  await rawPrisma.projectFeature.deleteMany({ where: { projectId: ORIGINAL_PROJECT_ID, key: { in: ["FOLLOW_UPS", "CLIENT_CENTER"] } } });
  const tables = (await rawPrisma.$queryRaw<Array<{ table_name: string }>>`SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`).map((r) => r.table_name);
  for (let pass = 0; pass < 4; pass++) for (const t of tables) await rawPrisma.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "projectId" = $1`, BIZ.id).catch(() => undefined);
  await rawPrisma.project.deleteMany({ where: { id: BIZ.id } });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: { in: ids.users } } });
  await rawPrisma.systemLog.deleteMany({ where: { actorUserId: { in: ids.users } } });
  await rawPrisma.user.deleteMany({ where: { id: { in: ids.users } } });
  await rawPrisma.permissionModule.deleteMany({ where: { id: { in: ids.roles } } });
  forgetProjectFeatureStates();
  await rawPrisma.$disconnect();
});

describe("creating", () => {
  it("from a WhatsApp conversation: one row linked to it, a CREATED event with the actor, shown in the side panel", async () => {
    const id = await make({ title: `Call back ${tag}`, due: "IN_1_HOUR", assignedUserId: s.agent.userId, conversation: WA() });
    const row = await rawPrisma.followUp.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ projectId: ORIGINAL_PROJECT_ID, accountId: fx.account, chatId: fx.groupChat, channelConversationId: null, status: "OPEN", createdById: s.agent.userId, assignedUserId: s.agent.userId });
    expect(await events(id)).toEqual([expect.objectContaining({ kind: "CREATED", actorUserId: s.agent.userId })]);
    const panel = await inIsp(() => loadWorkspace(s.agent, WA()));
    expect(panel?.access.followUps).toBe(true);
    expect(panel?.followUps?.map((f) => f.id)).toContain(id);
  });

  it("from a client profile, and with a person and a Team of this project", async () => {
    const id = await make({ title: `Visit ${tag}`, due: "TOMORROW_10", clientId: fx.client, assignedUserId: s.agent2.userId, assignedTeamId: fx.team, priority: "HIGH" });
    expect(await rawPrisma.followUp.findUniqueOrThrow({ where: { id } })).toMatchObject({ clientId: fx.client, accountId: null, assignedTeamId: fx.team, priority: "HIGH" });
    expect((await inIsp(() => server.loadClientFollowUps(fx.client))).map((f) => f.id)).toContain(id);
  });

  it("refuses another project's conversation, channel conversation, client, person and Team", async () => {
    const before = await rawPrisma.followUp.count();
    const tries = [
      { title: `x ${tag}`, due: "IN_1_HOUR", conversation: { kind: "whatsapp", accountId: fx.bizAccount, chatId: fx.bizGroupChat } },
      { title: `x ${tag}`, due: "IN_1_HOUR", conversation: { kind: "channel", conversationId: fx.conversation } },
      { title: `x ${tag}`, due: "IN_1_HOUR", clientId: fx.bizClient },
      { title: `x ${tag}`, due: "IN_1_HOUR", assignedUserId: fx.outsider },
      { title: `x ${tag}`, due: "IN_1_HOUR", assignedTeamId: fx.bizTeam },
    ];
    await feature(ORIGINAL_PROJECT_ID, "OMNICHANNEL", false);
    const results = await Promise.all(tries.map((t) => inIsp(() => actions.createFollowUp(t))));
    expect(results.map(errorOf)).toEqual([
      expect.stringMatching(/conversation could not be found/),
      // ISP has no OMNICHANNEL: the channel reply key grants nothing here.
      expect.stringMatching(/not enabled|permission/),
      expect.stringMatching(/client could not be found/),
      expect.stringMatching(/cannot be given follow-ups/),
      expect.stringMatching(/Team is not in this project/),
    ]);
    expect(await rawPrisma.followUp.count()).toBe(before);
  });

  it("linking a client needs clients.view and Client Management on", async () => {
    current = s.noClients;
    expect(errorOf(await inIsp(() => actions.createFollowUp({ title: `x ${tag}`, due: "IN_1_HOUR", clientId: fx.client })))).toMatch(/client could not be found/);
    current = s.agent;
    await feature(ORIGINAL_PROJECT_ID, "CLIENT_CENTER", false);
    expect(errorOf(await inIsp(() => actions.createFollowUp({ title: `x ${tag}`, due: "IN_1_HOUR", clientId: fx.client })))).toMatch(/client could not be found/);
    await feature(ORIGINAL_PROJECT_ID, "CLIENT_CENTER", true);
  });

  it("refuses a read-only role and a project with the feature off", async () => {
    current = s.viewer;
    expect(errorOf(await inIsp(() => actions.createFollowUp({ title: `x ${tag}`, due: "IN_1_HOUR" })))).toMatch(/permission/);
    current = s.agent;
    await feature(ORIGINAL_PROJECT_ID, "FOLLOW_UPS", false);
    expect(errorOf(await inIsp(() => actions.createFollowUp({ title: `x ${tag}`, due: "IN_1_HOUR" })))).toMatch(/Follow-ups is not enabled/);
    expect(await inIsp(() => actions.readFollowUpBadge())).toEqual({ overdue: 0, dueToday: 0 });
    expect((await inIsp(() => loadWorkspace(s.agent, WA())))?.followUps ?? null).toBeNull();
  });
});

describe("status moves", () => {
  it("done twice is one change and one DONE event; the second is told it is already done", async () => {
    const id = await make({ title: `Twice ${tag}`, due: "IN_1_HOUR" });
    expect(await inIsp(() => actions.setFollowUpStatus(id, "DONE"))).toEqual({ status: "DONE" });
    expect(errorOf(await inIsp(() => actions.setFollowUpStatus(id, "DONE")))).toMatch(/already done/);
    expect((await events(id)).map((e) => e.kind)).toEqual(["CREATED", "DONE"]);
    expect(await rawPrisma.followUp.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "DONE", completedById: s.agent.userId });
  });

  it("two people pressing Done at the same moment: exactly one wins", async () => {
    const id = await make({ title: `Race ${tag}`, due: "IN_1_HOUR" });
    const results = await Promise.all([
      inIsp(() => actions.setFollowUpStatus(id, "DONE")),
      inIsp(() => actions.setFollowUpStatus(id, "DONE")),
      inIsp(() => actions.setFollowUpStatus(id, "DISCARD")),
    ]);
    expect(results.filter((r) => !("error" in r))).toHaveLength(1);
    expect((await events(id)).filter((e) => e.kind !== "CREATED")).toHaveLength(1);
  });

  it("discard, reopen and edit: the history says what moved, and only an open follow-up is edited", async () => {
    const id = await make({ title: `Edit ${tag}`, due: "IN_1_HOUR", assignedUserId: s.agent.userId });
    expect(await inIsp(() => actions.setFollowUpStatus(id, "DISCARD"))).toEqual({ status: "DISCARDED" });
    expect(errorOf(await inIsp(() => actions.updateFollowUp(id, { title: "changed", due: "TOMORROW_10" })))).toMatch(/Only an open/);
    expect(await inIsp(() => actions.setFollowUpStatus(id, "REOPEN"))).toEqual({ status: "OPEN" });
    expect(await rawPrisma.followUp.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "OPEN", completedAt: null, completedById: null });
    // New time and new person: two events in one change.
    expect(await inIsp(() => actions.updateFollowUp(id, { title: `Edit ${tag}`, due: "TOMORROW_10", assignedUserId: s.agent2.userId }))).toEqual({ changed: true });
    // The same values again: nothing written.
    expect(await inIsp(() => actions.updateFollowUp(id, { title: `Edit ${tag}`, due: "TOMORROW_10", assignedUserId: s.agent2.userId }))).toEqual({ changed: false });
    // Only the title and priority: EDITED.
    expect(await inIsp(() => actions.updateFollowUp(id, { title: `Edited ${tag}`, due: "TOMORROW_10", assignedUserId: s.agent2.userId, priority: "URGENT" }))).toEqual({ changed: true });
    const kinds = (await events(id)).map((e) => e.kind);
    expect(kinds.slice(0, 3)).toEqual(["CREATED", "DISCARDED", "REOPENED"]);
    expect(kinds.slice(3, 5).sort()).toEqual(["REASSIGNED", "RESCHEDULED"]);
    expect(kinds.slice(5)).toEqual(["EDITED"]);
    const history = await inIsp(() => actions.readFollowUpHistory(id));
    expect("entries" in history && history.entries.find((e) => e.kind === "REASSIGNED")).toMatchObject({ from: "fu_agent", to: "fu_agent2" });
  });

  it("refuses a read-only role; the history stays append-only in the database", async () => {
    const id = await make({ title: `RO ${tag}`, due: "IN_1_HOUR", conversation: WA() });
    current = s.viewer;
    expect(errorOf(await inIsp(() => actions.setFollowUpStatus(id, "DONE")))).toMatch(/permission/);
    expect(errorOf(await inIsp(() => actions.updateFollowUp(id, { title: "x", due: "IN_1_HOUR" })))).toMatch(/permission/);
    expect("entries" in (await inIsp(() => actions.readFollowUpHistory(id)))).toBe(true);
    expect((await rawPrisma.followUp.findUniqueOrThrow({ where: { id } })).status).toBe("OPEN");
    const event = await rawPrisma.followUpEvent.findFirstOrThrow({ where: { followUpId: id } });
    await expect(rawPrisma.followUpEvent.update({ where: { id: event.id }, data: { actorName: "rewritten" } })).rejects.toThrow(/append-only/);
  });
});

describe("project isolation", () => {
  it("another project's follow-up id is not found for any action, and is never listed", async () => {
    current = s.bizAgent;
    const biz = await inBiz(() => actions.createFollowUp({ title: `Biz ${tag}`, due: "IN_1_HOUR", conversation: { kind: "channel", conversationId: fx.conversation } }));
    if ("error" in biz) throw new Error(biz.error);
    current = s.agent;
    expect(errorOf(await inIsp(() => actions.setFollowUpStatus(biz.id, "DONE")))).toMatch(/could not be found/);
    expect(errorOf(await inIsp(() => actions.updateFollowUp(biz.id, { title: "x", due: "IN_1_HOUR" })))).toMatch(/could not be found/);
    expect(errorOf(await inIsp(() => actions.readFollowUpHistory(biz.id)))).toMatch(/could not be found/);
    const team = await inIsp(() => server.listFollowUps(s.agent, "TEAM", { assignee: null, team: null, priority: null }, new Date()));
    expect(team.rows.map((r) => r.id)).not.toContain(biz.id);
    expect((await rawPrisma.followUp.findUniqueOrThrow({ where: { id: biz.id } })).status).toBe("OPEN");
  });

  it("the database refuses a follow-up whose conversation, Team or client is in another project", async () => {
    await expect(rawPrisma.followUp.create({ data: { projectId: ORIGINAL_PROJECT_ID, title: `db ${tag}`, dueAt: new Date(), accountId: fx.bizAccount, chatId: fx.bizGroupChat } })).rejects.toThrow();
    await expect(rawPrisma.followUp.create({ data: { projectId: ORIGINAL_PROJECT_ID, title: `db ${tag}`, dueAt: new Date(), assignedTeamId: fx.bizTeam } })).rejects.toThrow();
    await expect(rawPrisma.followUp.create({ data: { projectId: ORIGINAL_PROJECT_ID, title: `db ${tag}`, dueAt: new Date(), clientId: fx.bizClient } })).rejects.toThrow();
    // Both conversation shapes at once is refused too.
    await expect(
      rawPrisma.followUp.create({ data: { projectId: BIZ.id, title: `db ${tag}`, dueAt: new Date(), accountId: fx.bizAccount, chatId: fx.bizGroupChat, channelConversationId: fx.conversation } }),
    ).rejects.toThrow(/one_conversation/);
  });
});

describe("buckets and the reminder badge (Dhaka days)", () => {
  it("23:30 Dhaka: overdue / due today / upcoming split at Dhaka midnight, not UTC midnight; Mine includes my Team", async () => {
    const now = dhaka("2026-11-07T23:30:00");
    const mk = (title: string, dueAt: Date, extra: Record<string, unknown> = {}) =>
      rawPrisma.followUp.create({ data: { projectId: ORIGINAL_PROJECT_ID, title: `${title} ${tag}`, dueAt, createdById: s.agent.userId, ...extra }, select: { id: true } }).then((r) => r.id);
    const overdue = await mk("b-overdue", dhaka("2026-11-07T10:00:00"), { assignedUserId: s.bucket.userId });
    const today = await mk("b-today", dhaka("2026-11-07T23:59:00"), { assignedUserId: s.bucket.userId });
    // 18:30 UTC on the 7th is 00:30 Dhaka on the 8th: upcoming, although it is still the 7th in UTC.
    const tomorrow = await mk("b-tomorrow", new Date("2026-11-07T18:30:00Z"), { assignedUserId: s.bucket.userId });
    const teamOnly = await mk("b-team", dhaka("2026-11-07T23:45:00"), { assignedTeamId: fx.bucketTeam });
    const someoneElse = await mk("b-other", dhaka("2026-11-07T09:00:00"), { assignedUserId: s.agent.userId });
    const closed = await mk("b-closed", dhaka("2026-11-07T09:30:00"), { assignedUserId: s.bucket.userId, status: "DONE", completedAt: now });
    const filters = { assignee: null, team: null, priority: null };
    const idsOf = async (view: "OVERDUE" | "DUE_TODAY" | "UPCOMING" | "MINE" | "DONE") => (await inIsp(() => server.listFollowUps(s.bucket, view, filters, now))).rows.map((r) => r.id);
    const ours = [overdue, today, tomorrow, teamOnly, someoneElse, closed];
    const pick = (list: string[]) => list.filter((x) => ours.includes(x));
    expect(pick(await idsOf("OVERDUE"))).toEqual([someoneElse, overdue]);
    expect(pick(await idsOf("DUE_TODAY"))).toEqual([teamOnly, today]);
    expect(pick(await idsOf("UPCOMING"))).toEqual([tomorrow]);
    expect(pick(await idsOf("DONE"))).toEqual([closed]);
    expect(await idsOf("MINE")).toEqual([overdue, teamOnly, today, tomorrow]);
    expect(await inIsp(() => server.countMyAttention(s.bucket, now))).toEqual({ overdue: 1, dueToday: 2 });
    // One minute after Dhaka midnight the 23:45 / 23:59 ones are overdue and the 00:30 one is due today.
    expect(await inIsp(() => server.countMyAttention(s.bucket, dhaka("2026-11-08T00:01:00")))).toEqual({ overdue: 3, dueToday: 1 });
    // Filters narrow a bucket: only the Team's.
    const teamFilter = await inIsp(() => server.listFollowUps(s.bucket, "DUE_TODAY", { assignee: "none", team: fx.bucketTeam, priority: null }, now));
    expect(teamFilter.rows.map((r) => r.id)).toEqual([teamOnly]);
  });
});

