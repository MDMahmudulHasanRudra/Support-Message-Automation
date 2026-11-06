import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, ORIGINAL_PROJECT_ID, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Inbox V3 in the dashboard (server/conversationLifecycle.ts, server/actions/inboxLifecycle.ts): status moves
 * for WhatsApp and channel conversations with their history, WhatsApp assignment to a person and a Team, the
 * reopen policy, and every refusal — a read-only role, the feature off, another project's conversation, a
 * person or Team from outside the project.
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
const actions = await import("@/server/actions/inboxLifecycle");
const lifecycle = await import("@/server/conversationLifecycle");
const { loadWorkspace } = await import("@/server/inboxWorkspace");

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const ISP = { id: ORIGINAL_PROJECT_ID, slug: "isp-digital", name: "ISP Digital", status: "ACTIVE" as const };
let BIZ = { id: "", slug: `v3-biz-${tag}`, name: `V3 Biz ${tag}`, status: "ACTIVE" as const };
const inIsp = <T,>(fn: () => Promise<T>) => runWithProject(ISP, fn);
const inBiz = <T,>(fn: () => Promise<T>) => runWithProject(BIZ, fn);
const ids = { users: [] as string[], roles: [] as string[], accounts: [] as string[], teams: [] as string[] };
const s = {} as Record<"agent" | "viewer" | "admin" | "bizAgent", Session>;
const fx = {} as { account: string; groupChat: string; bizAccount: string; bizGroupChat: string; connection: string; conversation: string; team: string; bizTeam: string; outsider: string };

const WA = () => ({ kind: "whatsapp" as const, accountId: fx.account, chatId: fx.groupChat });
const CH = () => ({ kind: "channel" as const, conversationId: fx.conversation });

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
const waState = () => rawPrisma.whatsAppConversationState.findFirst({ where: { accountId: fx.account, chatId: fx.groupChat } });
const waEvents = () => rawPrisma.conversationEvent.findMany({ where: { accountId: fx.account, chatId: fx.groupChat }, orderBy: { createdAt: "asc" } });
/** The refusal sentence of an action result, if it refused. */
const errorOf = (r: object): string | undefined => ("error" in r ? (r as { error: string }).error : undefined);
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

beforeAll(async () => {
  const pid = { projectId: ORIGINAL_PROJECT_ID };
  fx.account = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `V3 ${tag}`, status: "CONNECTED" } })).id;
  fx.groupChat = `v3-${tag}@g.us`;
  await rawPrisma.whatsAppGroup.create({ data: { ...pid, accountId: fx.account, whatsappGroupId: fx.groupChat, name: `V3 Customer ${tag}`, isActive: true } });
  fx.team = (await rawPrisma.team.create({ data: { ...pid, name: `V3 Team ${tag}` } })).id;
  ids.accounts.push(fx.account);
  ids.teams.push(fx.team);

  const creator = await rawPrisma.user.create({ data: { username: `v3c_${tag}`, email: `v3c_${tag}@example.test`, name: "Creator", passwordHash: "x" } });
  ids.users.push(creator.id);
  BIZ = { ...BIZ, id: (await createProjectWithDefaults({ name: BIZ.name, slug: BIZ.slug, status: "ACTIVE", creatorUserId: creator.id }, rawPrisma)).id };
  fx.bizAccount = (await rawPrisma.whatsAppAccount.create({ data: { projectId: BIZ.id, label: `V3 Biz ${tag}`, status: "CONNECTED" } })).id;
  fx.bizGroupChat = `v3b-${tag}@g.us`;
  await rawPrisma.whatsAppGroup.create({ data: { projectId: BIZ.id, accountId: fx.bizAccount, whatsappGroupId: fx.bizGroupChat, name: `Biz group ${tag}`, isActive: true } });
  fx.bizTeam = (await rawPrisma.team.create({ data: { projectId: BIZ.id, name: `Biz Team ${tag}` } })).id;
  ids.accounts.push(fx.bizAccount);
  fx.connection = (await rawPrisma.channelConnection.create({ data: { projectId: BIZ.id, type: "TELEGRAM", name: "@v3", status: "CONNECTED", webhookKey: `v3w-${tag}` } })).id;
  fx.conversation = (await rawPrisma.channelConversation.create({ data: { projectId: BIZ.id, connectionId: fx.connection, type: "TELEGRAM", externalThreadId: `t-${tag}` } })).id;

  const agent = await role("V3 agent", ["messages.view", "messages.reply", "conversations.reply", "channels.view"]);
  const viewer = await role("V3 viewer", ["messages.view"]);
  const admin = await role("V3 admin", ["messages.view", "settings.view", "settings.edit"]);
  s.agent = await user("v3_agent", agent, [ORIGINAL_PROJECT_ID]);
  s.viewer = await user("v3_viewer", viewer, [ORIGINAL_PROJECT_ID]);
  s.admin = await user("v3_admin", admin, [ORIGINAL_PROJECT_ID]);
  s.bizAgent = await user("v3_bizagent", agent, [BIZ.id]);
  fx.outsider = (await user("v3_outsider", agent, [BIZ.id])).userId;
});

beforeEach(async () => {
  await feature(ORIGINAL_PROJECT_ID, "UNIFIED_INBOX_V3", true);
  await feature(BIZ.id, "UNIFIED_INBOX_V3", true);
  await feature(BIZ.id, "OMNICHANNEL", true);
  current = s.agent;
});

afterAll(async () => {
  await rawPrisma.conversationEvent.deleteMany({ where: { accountId: { in: ids.accounts } } });
  await rawPrisma.whatsAppConversationState.deleteMany({ where: { accountId: { in: ids.accounts } } });
  await rawPrisma.whatsAppAccount.deleteMany({ where: { id: { in: ids.accounts } } });
  await rawPrisma.team.deleteMany({ where: { id: { in: ids.teams } } });
  await rawPrisma.inboxLifecycleSettings.deleteMany({ where: { projectId: ORIGINAL_PROJECT_ID } });
  await rawPrisma.projectFeature.deleteMany({ where: { projectId: ORIGINAL_PROJECT_ID, key: "UNIFIED_INBOX_V3" } });
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

describe("WhatsApp conversation status", () => {
  it("open → pending → snoozed → open → resolved, one state row, one event per move with the actor", async () => {
    expect(await waState()).toBeNull();
    expect(await inIsp(() => actions.setConversationStatus(WA(), { to: "PENDING" }))).toEqual({ status: "PENDING" });
    expect(await waState()).toMatchObject({ status: "PENDING", conversationType: "GROUP" });
    expect(await inIsp(() => actions.setConversationStatus(WA(), { to: "SNOOZED", until: inHours(2) }))).toEqual({ status: "SNOOZED" });
    expect((await waState())?.snoozedUntil).not.toBeNull();
    expect(await inIsp(() => actions.setConversationStatus(WA(), { to: "OPEN" }))).toEqual({ status: "OPEN" });
    expect(await inIsp(() => actions.setConversationStatus(WA(), { to: "RESOLVED", note: "Fixed on call" }))).toEqual({ status: "RESOLVED" });
    expect(await waState()).toMatchObject({ status: "RESOLVED", resolvedById: s.agent.userId, resolutionNote: "Fixed on call", snoozedUntil: null });
    const events = await waEvents();
    expect(events.map((e) => e.kind)).toEqual(["PENDING", "SNOOZE", "UNSNOOZE", "RESOLVE"]);
    expect(events.every((e) => e.actorId === s.agent.userId)).toBe(true);
    // The note itself is kept on the state, never copied into the history.
    expect(JSON.stringify(events.at(-1)?.context)).not.toContain("Fixed on call");
    expect(await rawPrisma.whatsAppConversationState.count({ where: { accountId: fx.account } })).toBe(1);
  });

  it("refuses moves the rules refuse, and a no-op", async () => {
    // Now RESOLVED (previous test): pending and snooze need a reopen first.
    expect(errorOf(await inIsp(() => actions.setConversationStatus(WA(), { to: "PENDING" })))).toMatch(/Reopen it first/);
    expect(errorOf(await inIsp(() => actions.setConversationStatus(WA(), { to: "RESOLVED" })))).toMatch(/already resolved/);
    await inIsp(() => actions.setConversationStatus(WA(), { to: "OPEN" }));
    expect(errorOf(await inIsp(() => actions.setConversationStatus(WA(), { to: "SNOOZED", until: inHours(24 * 120) })))).toMatch(/at most 90 days/);
    expect(errorOf(await inIsp(() => actions.setConversationStatus(WA(), { to: "WHATEVER" })))).toBeTruthy();
  });

  it("the panel shows the status and the WhatsApp history once the feature is on", async () => {
    const data = await inIsp(() => loadWorkspace(s.agent, WA()));
    expect(data?.access.lifecycle).toBe(true);
    expect(data?.lifecycle?.status).toBe("OPEN");
    expect(data?.history.map((h) => h.kind)).toContain("RESOLVE");
  });
});

describe("WhatsApp assignment", () => {
  it("assigns a person and a Team of this project, with ASSIGNEE and TEAM events; clears them", async () => {
    expect(await inIsp(() => actions.setConversationAssignee(WA(), s.agent.userId))).toEqual({ ok: true });
    expect(await inIsp(() => actions.setConversationTeam(WA(), fx.team))).toEqual({ ok: true });
    expect(await waState()).toMatchObject({ assignedUserId: s.agent.userId, assignedTeamId: fx.team });
    expect(await inIsp(() => actions.setConversationAssignee(WA(), null))).toEqual({ ok: true });
    const kinds = (await waEvents()).map((e) => e.kind);
    expect(kinds.filter((k) => k === "ASSIGNEE")).toHaveLength(2);
    expect(kinds.filter((k) => k === "TEAM")).toHaveLength(1);
  });

  it("refuses a person without access to the project, and another project's Team", async () => {
    expect(errorOf(await inIsp(() => actions.setConversationAssignee(WA(), fx.outsider)))).toMatch(/cannot be assigned/);
    expect(errorOf(await inIsp(() => actions.setConversationTeam(WA(), fx.bizTeam)))).toMatch(/not in this project/);
    // The database itself refuses a Team from another project, whatever the action did.
    await expect(
      rawPrisma.whatsAppConversationState.updateMany({ where: { accountId: fx.account, chatId: fx.groupChat }, data: { assignedTeamId: fx.bizTeam } }),
    ).rejects.toThrow();
  });
});

describe("channel conversation status", () => {
  it("snooze and resolve are stored on the conversation (resolved as CLOSED) with their events", async () => {
    current = s.bizAgent;
    expect(await inBiz(() => actions.setConversationStatus(CH(), { to: "SNOOZED", until: inHours(1) }))).toEqual({ status: "SNOOZED" });
    expect(await rawPrisma.channelConversation.findUniqueOrThrow({ where: { id: fx.conversation } })).toMatchObject({ status: "SNOOZED" });
    expect(await inBiz(() => actions.setConversationStatus(CH(), { to: "RESOLVED" }))).toEqual({ status: "RESOLVED" });
    const c = await rawPrisma.channelConversation.findUniqueOrThrow({ where: { id: fx.conversation } });
    expect(c).toMatchObject({ status: "CLOSED", snoozedUntil: null, resolvedById: s.bizAgent.userId });
    expect(c.closedAt).not.toBeNull();
    expect(await inBiz(() => lifecycle.loadLifecycle(CH()))).toMatchObject({ status: "RESOLVED" });
    const kinds = (await rawPrisma.conversationEvent.findMany({ where: { channelConversationId: fx.conversation }, orderBy: { createdAt: "asc" } })).map((e) => e.kind);
    expect(kinds).toEqual(["SNOOZE", "RESOLVE"]);
  });
});

describe("refusals", () => {
  it("a read-only role, the feature off, and another project's conversation change nothing", async () => {
    const before = await waState();
    current = s.viewer;
    expect(errorOf(await inIsp(() => actions.setConversationStatus(WA(), { to: "PENDING" })))).toBeTruthy();
    current = s.agent;
    await feature(ORIGINAL_PROJECT_ID, "UNIFIED_INBOX_V3", false);
    expect(errorOf(await inIsp(() => actions.setConversationStatus(WA(), { to: "PENDING" })))).toMatch(/switched off/);
    await feature(ORIGINAL_PROJECT_ID, "UNIFIED_INBOX_V3", true);
    // From ISP Digital, Biz's WhatsApp chat and channel conversation do not exist.
    expect(errorOf(await inIsp(() => actions.setConversationStatus({ kind: "whatsapp", accountId: fx.bizAccount, chatId: fx.bizGroupChat }, { to: "PENDING" })))).toMatch(/could not be found/);
    expect(errorOf(await inIsp(() => actions.setConversationStatus(CH(), { to: "OPEN" })))).toBeTruthy();
    expect((await waState())?.status).toBe(before?.status);
    expect(await rawPrisma.whatsAppConversationState.count({ where: { accountId: fx.bizAccount } })).toBe(0);
  });
});

describe("the reopen policy", () => {
  it("is saved with settings.edit only, and reads back", async () => {
    current = s.agent;
    expect(errorOf(await inIsp(() => actions.saveInboxLifecyclePolicy({ reopenResolved: false, reopenSnoozed: true })))).toBeTruthy();
    current = s.admin;
    expect(await inIsp(() => actions.saveInboxLifecyclePolicy({ reopenResolved: false, reopenSnoozed: true }))).toEqual({ ok: true });
    expect(await inIsp(() => lifecycle.loadLifecyclePolicy())).toEqual({ reopenResolvedOnCustomerMessage: false, reopenSnoozedOnCustomerMessage: true });
  });
});
