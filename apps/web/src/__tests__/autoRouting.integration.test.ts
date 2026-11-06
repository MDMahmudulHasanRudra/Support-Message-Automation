import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, ORIGINAL_PROJECT_ID, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Automatic routing in the dashboard (AUTO_ROUTING.md). The worker's suite proves who gets a conversation and
 * that the lock is needed; this one proves what only the web does:
 *   - "Distribute evenly" spreads the selection in turn, with the person who pressed it as the actor, and leaves
 *     alone what has somebody, what is not Open, another project's conversation, and the feature off;
 *   - settings need settings.edit, and a pool cannot name another project's Team or somebody with no access;
 *   - the Routing panel names who could take a conversation and why the others could not;
 *   - the conversation's history marks a routed assignment as automatic.
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
const { forgetProjectFeatureStates } = await import("@/server/projectFeatures");
const inbox = await import("@/server/actions/inbox");
const routingActions = await import("@/server/actions/autoRouting");
const routing = await import("@/server/autoRouting");
const workspace = await import("@/server/inboxWorkspace");

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const ISP = { id: ORIGINAL_PROJECT_ID, slug: "isp-digital", name: "ISP Digital", status: "ACTIVE" as const };
let BIZ = { id: "", slug: `rt-biz-${tag}`, name: `Routing Biz ${tag}`, status: "ACTIVE" as const };
const inIsp = <T,>(fn: () => Promise<T>) => runWithProject(ISP, fn);
const ids = { users: [] as string[], roles: [] as string[], connections: [] as string[], teams: [] as string[] };
const s = {} as Record<"agent" | "readOnly" | "admin" | "viewerOnly", Session>;
let connection = "";
let bizConnection = "";
let bizTeam = "";
let outsider = "";
let n = 0;

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
const conversation = (over: Record<string, unknown> = {}, connectionId = connection, projectId = ORIGINAL_PROJECT_ID) =>
  rawPrisma.channelConversation.create({ data: { projectId, connectionId, type: "TELEGRAM", externalThreadId: `t-${tag}-${n++}`, status: "OPEN", lastInboundAt: new Date(), ...over } });
const refOf = (id: string) => ({ kind: "channel" as const, conversationId: id });
const assigneesOf = async (list: string[]) => (await rawPrisma.channelConversation.findMany({ where: { id: { in: list } }, select: { assignedUserId: true } })).map((c) => c.assignedUserId);
const SETTINGS = { enabled: true, channels: ["TELEGRAM"], includeWhatsAppGroups: false, method: "ROUND_ROBIN", maxOpenPerAgent: 15, poolTeamIds: [] as string[], onlyOnDuty: false, requireRecentlySeen: false, recentlySeenMinutes: 15 };
let poolA = "";
let poolB = "";
let noPermission = "";

beforeAll(async () => {
  connection = (await rawPrisma.channelConnection.create({ data: { projectId: ORIGINAL_PROJECT_ID, type: "TELEGRAM", name: "@rt", status: "CONNECTED", webhookKey: `rtw-${tag}` } })).id;
  ids.connections.push(connection);
  const creator = await rawPrisma.user.create({ data: { username: `rtc_${tag}`, email: `rtc_${tag}@example.test`, name: "Creator", passwordHash: "x" } });
  ids.users.push(creator.id);
  BIZ = { ...BIZ, id: (await createProjectWithDefaults({ name: BIZ.name, slug: BIZ.slug, status: "ACTIVE", creatorUserId: creator.id }, rawPrisma)).id };
  bizConnection = (await rawPrisma.channelConnection.create({ data: { projectId: BIZ.id, type: "TELEGRAM", name: "@rtb", status: "CONNECTED", webhookKey: `rtb-${tag}` } })).id;
  ids.connections.push(bizConnection);
  bizTeam = (await rawPrisma.team.create({ data: { projectId: BIZ.id, name: `Biz team ${tag}` } })).id;

  const agentRole = await role("RT agent", ["messages.view", "messages.reply", "conversations.reply", "channels.view"]);
  const readOnlyRole = await role("RT read", ["messages.view", "channels.view"]);
  const adminRole = await role("RT admin", ["messages.view", "settings.view", "settings.edit"]);
  const viewerRole = await role("RT settings viewer", ["messages.view", "settings.view"]);
  s.agent = await user("rt_agent", agentRole, [ORIGINAL_PROJECT_ID]);
  s.readOnly = await user("rt_read", readOnlyRole, [ORIGINAL_PROJECT_ID]);
  s.admin = await user("rt_admin", adminRole, [ORIGINAL_PROJECT_ID]);
  s.viewerOnly = await user("rt_viewer", viewerRole, [ORIGINAL_PROJECT_ID]);
  poolA = (await user("rt_pool_a", agentRole, [ORIGINAL_PROJECT_ID])).userId;
  poolB = (await user("rt_pool_b", agentRole, [ORIGINAL_PROJECT_ID])).userId;
  noPermission = (await user("rt_pool_c", readOnlyRole, [ORIGINAL_PROJECT_ID])).userId;
  outsider = (await user("rt_outsider", agentRole, [BIZ.id])).userId;
});

beforeEach(async () => {
  await feature(ORIGINAL_PROJECT_ID, "UNIFIED_INBOX_V3", true);
  await feature(ORIGINAL_PROJECT_ID, "AUTO_ROUTING", true);
  await feature(ORIGINAL_PROJECT_ID, "OMNICHANNEL", true);
  const row = { ...SETTINGS, poolUserIds: [poolA, poolB], lastPickedUserId: null };
  await rawPrisma.routingSettings.upsert({ where: { projectId: ORIGINAL_PROJECT_ID }, create: { projectId: ORIGINAL_PROJECT_ID, ...row }, update: row });
  current = s.agent;
});

afterAll(async () => {
  await rawPrisma.conversationEvent.deleteMany({ where: { channelConversation: { connectionId: { in: ids.connections } } } });
  await rawPrisma.channelConversation.deleteMany({ where: { connectionId: { in: ids.connections } } });
  await rawPrisma.channelConnection.deleteMany({ where: { id: { in: ids.connections } } });
  await rawPrisma.routingSettings.deleteMany({ where: { projectId: ORIGINAL_PROJECT_ID } });
  await rawPrisma.projectFeature.deleteMany({ where: { projectId: ORIGINAL_PROJECT_ID, key: { in: ["UNIFIED_INBOX_V3", "AUTO_ROUTING", "OMNICHANNEL"] } } });
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

describe("Distribute evenly", () => {
  it("gives the selection to the pool in turn, with the person who pressed it as the actor", async () => {
    const list = (await Promise.all([conversation(), conversation(), conversation(), conversation()])).map((c) => c.id);
    const result = await inIsp(() => inbox.bulkUpdateConversations(list.map(refOf), { op: "distribute" }));
    expect(result).toMatchObject({ changed: 4, unchanged: 0, skipped: 0 });
    const assignees = await assigneesOf(list);
    expect(assignees.filter((a) => a === poolA)).toHaveLength(2);
    expect(assignees.filter((a) => a === poolB)).toHaveLength(2);
    const events = await rawPrisma.conversationEvent.findMany({ where: { channelConversationId: { in: list } } });
    expect(events).toHaveLength(4);
    for (const e of events) expect(e).toMatchObject({ kind: "ASSIGNEE", actorId: s.agent.userId, context: { reason: "AUTO_ROUTING", via: "DISTRIBUTE", method: "ROUND_ROBIN" } });
  });

  it("never replaces somebody, and leaves a conversation that is not Open alone", async () => {
    const held = await conversation({ assignedUserId: s.agent.userId });
    const closed = await conversation({ status: "CLOSED" });
    const free = await conversation();
    const result = await inIsp(() => inbox.bulkUpdateConversations([held, closed, free].map((c) => refOf(c.id)), { op: "distribute" }));
    expect(result).toMatchObject({ changed: 1, unchanged: 1, skipped: 1 });
    expect(await assigneesOf([held.id])).toEqual([s.agent.userId]);
    expect(await assigneesOf([closed.id])).toEqual([null]);
    expect(await rawPrisma.conversationEvent.count({ where: { channelConversationId: { in: [held.id, closed.id] } } })).toBe(0);
  });

  it("a WhatsApp group with an owner is left alone: its owner is set on the Groups page", async () => {
    const account = await rawPrisma.whatsAppAccount.create({ data: { projectId: ORIGINAL_PROJECT_ID, label: `RT ${tag}`, status: "CONNECTED" } });
    const member = await rawPrisma.internalTeamMember.create({ data: { projectId: ORIGINAL_PROJECT_ID, name: `Owner ${tag}`, role: "Support", phoneNumber: `8801700${String(n++).padStart(6, "0")}` } });
    const chatId = `${tag}-${n++}@g.us`;
    await rawPrisma.whatsAppGroup.create({ data: { projectId: ORIGINAL_PROJECT_ID, accountId: account.id, whatsappGroupId: chatId, name: `Owned ${tag}`, isActive: true, assignedTeamMemberId: member.id } });
    const result = await inIsp(() => inbox.bulkUpdateConversations([{ kind: "whatsapp", accountId: account.id, chatId }], { op: "distribute" }));
    expect(result).toMatchObject({ changed: 0, skipped: 1 });
    expect(await rawPrisma.whatsAppConversationState.count({ where: { accountId: account.id, chatId } })).toBe(0);
    await rawPrisma.whatsAppGroup.deleteMany({ where: { accountId: account.id } });
    await rawPrisma.internalTeamMember.delete({ where: { id: member.id } });
    await rawPrisma.whatsAppAccount.delete({ where: { id: account.id } });
  });

  it("another project's conversation in the selection is not touched", async () => {
    const theirs = await conversation({}, bizConnection, BIZ.id);
    const result = await inIsp(() => inbox.bulkUpdateConversations([refOf(theirs.id)], { op: "distribute" }));
    expect("error" in result ? 0 : result.changed).toBe(0);
    expect(await assigneesOf([theirs.id])).toEqual([null]);
  });

  it("a role that cannot reply changes nothing", async () => {
    current = s.readOnly;
    const c = await conversation();
    const result = await inIsp(() => inbox.bulkUpdateConversations([refOf(c.id)], { op: "distribute" }));
    expect("error" in result ? 0 : result.changed).toBe(0);
    expect(await assigneesOf([c.id])).toEqual([null]);
  });

  it("with AUTO_ROUTING or Inbox V3 off it is refused, and with an empty pool it says what to do", async () => {
    const c = await conversation();
    await feature(ORIGINAL_PROJECT_ID, "AUTO_ROUTING", false);
    expect(await inIsp(() => inbox.bulkUpdateConversations([refOf(c.id)], { op: "distribute" }))).toMatchObject({ error: expect.stringContaining("switched off") });
    await feature(ORIGINAL_PROJECT_ID, "AUTO_ROUTING", true);
    await feature(ORIGINAL_PROJECT_ID, "UNIFIED_INBOX_V3", false);
    expect(await inIsp(() => inbox.bulkUpdateConversations([refOf(c.id)], { op: "distribute" }))).toMatchObject({ error: expect.stringContaining("switched off") });
    await feature(ORIGINAL_PROJECT_ID, "UNIFIED_INBOX_V3", true);
    await rawPrisma.routingSettings.update({ where: { projectId: ORIGINAL_PROJECT_ID }, data: { poolUserIds: [] } });
    expect(await inIsp(() => inbox.bulkUpdateConversations([refOf(c.id)], { op: "distribute" }))).toMatchObject({ error: expect.stringContaining("Settings") });
    expect(await assigneesOf([c.id])).toEqual([null]);
  });

  it("nobody eligible leaves it unassigned, says so and records the reason by counts", async () => {
    await rawPrisma.routingSettings.update({ where: { projectId: ORIGINAL_PROJECT_ID }, data: { poolUserIds: [noPermission] } });
    const c = await conversation();
    const result = await inIsp(() => inbox.bulkUpdateConversations([refOf(c.id)], { op: "distribute" }));
    expect(result).toMatchObject({ changed: 0, skipped: 1, notes: [expect.stringContaining("Nobody in the routing pool")] });
    expect(await assigneesOf([c.id])).toEqual([null]);
    expect(await rawPrisma.routingSettings.findUniqueOrThrow({ where: { projectId: ORIGINAL_PROJECT_ID } })).toMatchObject({ lastUnroutedReasons: { NO_PERMISSION: 1 } });
  });
});

describe("settings", () => {
  const form = () => ({ ...SETTINGS, poolUserIds: [poolA] });

  it("need settings.edit", async () => {
    current = s.viewerOnly;
    expect(await inIsp(() => routingActions.saveAutoRoutingSettings(form()))).toHaveProperty("error");
  });

  it("refuse a pool naming another project's Team or somebody with no access to this project", async () => {
    current = s.admin;
    expect(await inIsp(() => routingActions.saveAutoRoutingSettings({ ...form(), poolTeamIds: [bizTeam] }))).toMatchObject({ error: expect.stringContaining("Team") });
    expect(await inIsp(() => routingActions.saveAutoRoutingSettings({ ...form(), poolUserIds: [outsider] }))).toMatchObject({ error: expect.stringContaining("no access") });
    const stored = await rawPrisma.routingSettings.findUniqueOrThrow({ where: { projectId: ORIGINAL_PROJECT_ID } });
    expect(stored.poolTeamIds).toEqual([]);
    expect(stored.poolUserIds).not.toContain(outsider);
  });

  it("switching on stamps enabledAt once, so an old backlog is never handed out; a later save keeps it", async () => {
    current = s.admin;
    await rawPrisma.routingSettings.update({ where: { projectId: ORIGINAL_PROJECT_ID }, data: { enabled: false, enabledAt: null } });
    expect(await inIsp(() => routingActions.saveAutoRoutingSettings(form()))).toEqual({ ok: true });
    const first = await rawPrisma.routingSettings.findUniqueOrThrow({ where: { projectId: ORIGINAL_PROJECT_ID } });
    expect(first.enabledAt).toBeInstanceOf(Date);
    expect(await inIsp(() => routingActions.saveAutoRoutingSettings({ ...form(), maxOpenPerAgent: 20 }))).toEqual({ ok: true });
    const second = await rawPrisma.routingSettings.findUniqueOrThrow({ where: { projectId: ORIGINAL_PROJECT_ID } });
    expect(second.enabledAt?.getTime()).toBe(first.enabledAt?.getTime());
    expect(second.maxOpenPerAgent).toBe(20);
  });
});

describe("what a person sees", () => {
  it("the Routing panel names who could take one and why the others could not", async () => {
    await rawPrisma.routingSettings.update({ where: { projectId: ORIGINAL_PROJECT_ID }, data: { poolUserIds: [poolA, noPermission] } });
    const panel = await inIsp(() => routing.loadRoutingPanel());
    expect(panel.find((r) => r.userId === poolA)).toMatchObject({ eligible: true, reason: null });
    expect(panel.find((r) => r.userId === noPermission)).toMatchObject({ eligible: false, reason: "NO_PERMISSION" });
  });

  it("the conversation's history marks a routed assignment as automatic, and a person's as not", async () => {
    const routed = await conversation();
    await inIsp(() => inbox.bulkUpdateConversations([refOf(routed.id)], { op: "distribute" }));
    await rawPrisma.conversationEvent.create({ data: { projectId: ORIGINAL_PROJECT_ID, channelConversationId: routed.id, kind: "ASSIGNEE", fromValue: null, toValue: s.agent.userId, actorId: s.agent.userId } });
    const data = await inIsp(() => workspace.loadWorkspace(s.agent, refOf(routed.id)));
    const assignments = data!.history.filter((h) => h.kind === "ASSIGNEE");
    expect(assignments).toHaveLength(2);
    expect(assignments.filter((h) => h.auto)).toHaveLength(1);
  });
});
