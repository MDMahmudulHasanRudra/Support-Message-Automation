import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, ORIGINAL_PROJECT_ID, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Support tickets (TICKETS.md): numbers per project, one change for two people pressing at once, the paused clock, the
 * link to a conversation and client, and every refusal: a read-only role, the feature off, another project's ticket,
 * conversation, person or Team. And that nothing here reaches a customer.
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
const actions = await import("@/server/actions/tickets");
const server = await import("@/server/tickets");

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const ISP = { id: ORIGINAL_PROJECT_ID, slug: "isp-digital", name: "ISP Digital", status: "ACTIVE" as const };
let BIZ = { id: "", slug: `tk-biz-${tag}`, name: `TK Biz ${tag}`, status: "ACTIVE" as const };
const inIsp = <T,>(fn: () => Promise<T>) => runWithProject(ISP, fn);
const inBiz = <T,>(fn: () => Promise<T>) => runWithProject(BIZ, fn);
const ids = { users: [] as string[], roles: [] as string[], accounts: [] as string[], teams: [] as string[], clients: [] as string[], tickets: [] as string[] };
const s = {} as Record<"agent" | "agent2" | "viewer" | "bizAgent", Session>;
const fx = {} as { account: string; chat: string; bizAccount: string; bizChat: string; team: string; bizTeam: string; client: string; outsider: string };

const WA = () => ({ kind: "whatsapp" as const, accountId: fx.account, chatId: fx.chat });
const errorOf = (r: object): string | undefined => ("error" in r ? (r as { error: string }).error : undefined);

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
async function make(input: Parameters<typeof actions.createTicket>[0] = {}) {
  const r = await inIsp(() => actions.createTicket({ subject: `Line down ${tag}`, ...input }));
  if ("error" in r) throw new Error(r.error);
  ids.tickets.push(r.id);
  return r;
}
const row = (id: string) => rawPrisma.ticket.findUniqueOrThrow({ where: { id } });
const events = (id: string) => rawPrisma.ticketEvent.findMany({ where: { ticketId: id }, orderBy: { createdAt: "asc" }, select: { kind: true, fromValue: true, toValue: true, body: true } });

beforeAll(async () => {
  const pid = { projectId: ORIGINAL_PROJECT_ID };
  fx.account = (await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `TK ${tag}`, status: "CONNECTED" } })).id;
  fx.chat = `9${parseInt(tag, 16)}-1@g.us`;
  await rawPrisma.whatsAppGroup.create({ data: { ...pid, accountId: fx.account, whatsappGroupId: fx.chat, name: `TK Customer ${tag}`, isActive: true } });
  fx.team = (await rawPrisma.team.create({ data: { ...pid, name: `TK Team ${tag}` } })).id;
  fx.client = (await rawPrisma.client.create({ data: { ...pid, code: `TK-${tag}`, name: `TK Client ${tag}` } })).id;
  await rawPrisma.clientWhatsAppGroupLink.create({ data: { ...pid, clientId: fx.client, accountId: fx.account, whatsappGroupId: fx.chat, groupName: `TK Customer ${tag}` } });
  ids.accounts.push(fx.account);
  ids.teams.push(fx.team);
  ids.clients.push(fx.client);

  const creator = await rawPrisma.user.create({ data: { username: `tkc_${tag}`, email: `tkc_${tag}@example.test`, name: "Creator", passwordHash: "x" } });
  ids.users.push(creator.id);
  BIZ = { ...BIZ, id: (await createProjectWithDefaults({ name: BIZ.name, slug: BIZ.slug, status: "ACTIVE", creatorUserId: creator.id }, rawPrisma)).id };
  fx.bizAccount = (await rawPrisma.whatsAppAccount.create({ data: { projectId: BIZ.id, label: `TK Biz ${tag}`, status: "CONNECTED" } })).id;
  fx.bizChat = `tkb-${tag}@g.us`;
  await rawPrisma.whatsAppGroup.create({ data: { projectId: BIZ.id, accountId: fx.bizAccount, whatsappGroupId: fx.bizChat, name: `Biz group ${tag}`, isActive: true } });
  fx.bizTeam = (await rawPrisma.team.create({ data: { projectId: BIZ.id, name: `Biz Team ${tag}` } })).id;
  ids.accounts.push(fx.bizAccount);

  const agent = await role("TK agent", ["messages.view", "messages.reply", "conversations.reply", "clients.view", "settings.edit"]);
  const viewer = await role("TK viewer", ["messages.view"]);
  s.agent = await user("tk_agent", agent, [ORIGINAL_PROJECT_ID]);
  s.agent2 = await user("tk_agent2", agent, [ORIGINAL_PROJECT_ID]);
  s.viewer = await user("tk_viewer", viewer, [ORIGINAL_PROJECT_ID]);
  s.bizAgent = await user("tk_bizagent", agent, [BIZ.id]);
  fx.outsider = (await user("tk_outsider", agent, [BIZ.id])).userId;
});

beforeEach(async () => {
  await feature(ORIGINAL_PROJECT_ID, "CLIENT_CENTER", true);
  await feature(ORIGINAL_PROJECT_ID, "TICKETS", true);
  await feature(BIZ.id, "TICKETS", true);
  current = s.agent;
});

afterAll(async () => {
  await rawPrisma.ticket.deleteMany({ where: { OR: [{ id: { in: ids.tickets } }, { projectId: BIZ.id }] } });
  await rawPrisma.ticketSettings.deleteMany({ where: { projectId: ORIGINAL_PROJECT_ID } });
  await rawPrisma.clientWhatsAppGroupLink.deleteMany({ where: { clientId: { in: ids.clients } } });
  await rawPrisma.client.deleteMany({ where: { id: { in: ids.clients } } });
  await rawPrisma.whatsAppAccount.deleteMany({ where: { id: { in: ids.accounts } } });
  await rawPrisma.team.deleteMany({ where: { id: { in: ids.teams } } });
  await rawPrisma.projectFeature.deleteMany({ where: { projectId: ORIGINAL_PROJECT_ID, key: { in: ["TICKETS", "CLIENT_CENTER"] } } });
  const tables = (await rawPrisma.$queryRaw<Array<{ table_name: string }>>`SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`).map((t) => t.table_name);
  for (let pass = 0; pass < 4; pass++) for (const t of tables) await rawPrisma.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "projectId" = $1`, BIZ.id).catch(() => undefined);
  await rawPrisma.project.deleteMany({ where: { id: BIZ.id } });
  await rawPrisma.user.deleteMany({ where: { id: { in: ids.users } } });
  await rawPrisma.permissionModule.deleteMany({ where: { id: { in: ids.roles } } });
});

describe("creating a ticket", () => {
  it("numbers are per project, and two at once never get the same one", async () => {
    const made = await Promise.all(Array.from({ length: 6 }, () => make()));
    const numbers = made.map((t) => t.number);
    expect(new Set(numbers).size).toBe(6);
    current = s.bizAgent;
    const first = await inBiz(() => actions.createTicket({ subject: "Other project" }));
    expect(first).toMatchObject({ number: 1 });
  });

  it("gets the due time of its priority and starts its history", async () => {
    const before = Date.now();
    const t = await make({ priority: "URGENT" });
    const stored = await row(t.id);
    expect(stored.dueAt!.getTime() - before).toBeGreaterThan(3.9 * 3_600_000);
    expect(stored.dueAt!.getTime() - before).toBeLessThan(4.1 * 3_600_000);
    expect(await events(t.id)).toMatchObject([{ kind: "CREATED" }]);
  });

  it("from a conversation: links it, and brings the client that conversation is already linked to", async () => {
    const t = await make({ conversation: WA() });
    expect(await row(t.id)).toMatchObject({ accountId: fx.account, chatId: fx.chat, clientId: fx.client });
    const listed = await inIsp(() => server.loadConversationTickets(WA()));
    expect(listed.map((x) => x.id)).toContain(t.id);
  });

  it("creating one sends nothing to anybody", async () => {
    const before = await rawPrisma.outboundMessage.count({ where: { accountId: fx.account } });
    await make({ conversation: WA() });
    expect(await rawPrisma.outboundMessage.count({ where: { accountId: fx.account } })).toBe(before);
  });
});

describe("refusals", () => {
  it("a read-only role can see but not change", async () => {
    const t = await make();
    current = s.viewer;
    expect(errorOf(await inIsp(() => actions.createTicket({ subject: "No" })))).toBeTruthy();
    expect(errorOf(await inIsp(() => actions.setTicketStatus(t.id, "RESOLVED")))).toBeTruthy();
    expect(errorOf(await inIsp(() => actions.addTicketNote(t.id, "No")))).toBeTruthy();
    expect((await row(t.id)).status).toBe("OPEN");
  });

  it("with the feature off nothing works", async () => {
    const t = await make();
    await feature(ORIGINAL_PROJECT_ID, "TICKETS", false);
    expect(errorOf(await inIsp(() => actions.setTicketStatus(t.id, "RESOLVED")))).toBeTruthy();
    expect(errorOf(await inIsp(() => actions.createTicket({ subject: "No" })))).toBeTruthy();
  });

  it("another project's ticket, conversation, person and Team are not found", async () => {
    const mine = await make();
    current = s.bizAgent;
    expect(await inBiz(() => actions.setTicketStatus(mine.id, "RESOLVED"))).toEqual({ error: "That ticket no longer exists." });
    current = s.agent;
    expect(errorOf(await inIsp(() => actions.createTicket({ subject: "x", conversation: { kind: "whatsapp", accountId: fx.bizAccount, chatId: fx.bizChat } })))).toContain("could not be found");
    expect(errorOf(await inIsp(() => actions.createTicket({ subject: "x", assignedUserId: fx.outsider })))).toContain("cannot be given");
    expect(errorOf(await inIsp(() => actions.createTicket({ subject: "x", assignedTeamId: fx.bizTeam })))).toContain("not in this project");
  });

  it("the database itself refuses a ticket pointing at another project", async () => {
    await expect(rawPrisma.ticket.create({ data: { projectId: ORIGINAL_PROJECT_ID, number: 999_000, subject: "x", accountId: fx.bizAccount, chatId: fx.bizChat } })).rejects.toThrow();
  });

  it("the history cannot be rewritten", async () => {
    const t = await make();
    await expect(rawPrisma.ticketEvent.updateMany({ where: { ticketId: t.id }, data: { actorName: "Someone else" } })).rejects.toThrow(/append-only/);
  });
});

describe("working a ticket", () => {
  it("two people pressing at once make one change and one history line", async () => {
    const t = await make();
    const results = await Promise.all([inIsp(() => actions.setTicketStatus(t.id, "RESOLVED")), inIsp(() => actions.setTicketStatus(t.id, "RESOLVED"))]);
    expect(results.filter((r) => "ok" in r)).toHaveLength(1);
    expect((await events(t.id)).filter((e) => e.kind === "STATUS")).toHaveLength(1);
  });

  it("an edit made on a stale page is refused", async () => {
    const t = await make();
    const seen = (await row(t.id)).updatedAt.toISOString();
    expect(await inIsp(() => actions.updateTicket(t.id, seen, { priority: "HIGH" }))).toEqual({ ok: true });
    expect(errorOf(await inIsp(() => actions.updateTicket(t.id, seen, { priority: "URGENT" })))).toContain("changed by someone else");
    expect((await row(t.id)).priority).toBe("HIGH");
  });

  it("waiting on the customer adds the wait back to the due time", async () => {
    const t = await make();
    await inIsp(() => actions.setTicketStatus(t.id, "WAITING_CUSTOMER"));
    const paused = await row(t.id);
    expect(paused.pausedAt).not.toBeNull();
    await rawPrisma.ticket.update({ where: { id: t.id }, data: { pausedAt: new Date(paused.pausedAt!.getTime() - 2 * 3_600_000) } });
    await inIsp(() => actions.setTicketStatus(t.id, "IN_PROGRESS"));
    const back = await row(t.id);
    expect(back.pausedAt).toBeNull();
    expect(back.dueAt!.getTime() - paused.dueAt!.getTime()).toBeGreaterThan(1.9 * 3_600_000);
  });

  it("a resolved ticket must be reopened before it is changed; notes still work", async () => {
    const t = await make();
    await inIsp(() => actions.setTicketStatus(t.id, "RESOLVED"));
    const r = await row(t.id);
    expect(errorOf(await inIsp(() => actions.updateTicket(t.id, r.updatedAt.toISOString(), { priority: "HIGH" })))).toContain("Reopen");
    expect(await inIsp(() => actions.addTicketNote(t.id, "Customer confirmed."))).toEqual({ ok: true });
    expect((await events(t.id)).at(-1)).toMatchObject({ kind: "NOTE", body: "Customer confirmed." });
  });

  it("the Mine, Unassigned and Overdue lists mean what they say", async () => {
    const mine = await make({ assignedUserId: s.agent.userId });
    const nobody = await make({ assignedUserId: null });
    const late = await make({ assignedUserId: s.agent2.userId, due: "2026-01-01T10:00" });
    const list = (view: "MINE" | "UNASSIGNED" | "OVERDUE") => inIsp(() => server.listTickets(s.agent, view, server.readTicketFilters({}), new Date()));
    expect((await list("MINE")).rows.map((r) => r.id)).toContain(mine.id);
    expect((await list("MINE")).rows.map((r) => r.id)).not.toContain(late.id);
    expect((await list("UNASSIGNED")).rows.map((r) => r.id)).toContain(nobody.id);
    expect((await list("OVERDUE")).rows.map((r) => r.id)).toContain(late.id);
  });

  it("a search by number finds the ticket", async () => {
    const t = await make();
    const found = await inIsp(() => server.listTickets(s.agent, "ACTIVE", server.readTicketFilters({ q: `T-${t.number}` }), new Date()));
    expect(found.rows.map((r) => r.id)).toEqual([t.id]);
  });
});

describe("settings", () => {
  it("a new target applies to new tickets", async () => {
    const form = new FormData();
    for (const [k, v] of Object.entries({ urgentHours: "1", highHours: "2", normalHours: "3", lowHours: "4", categories: "Network\nBilling" })) form.set(k, v);
    expect(await inIsp(() => actions.saveTicketSettings({}, form))).toMatchObject({ success: expect.any(String) });
    const before = Date.now();
    const t = await make({ priority: "NORMAL", category: "Network" });
    const due = (await row(t.id)).dueAt!.getTime() - before;
    expect(due).toBeLessThan(3.1 * 3_600_000);
    expect(errorOf(await inIsp(() => actions.createTicket({ subject: "x", category: "Technical" })))).toContain("category");
  });
});
