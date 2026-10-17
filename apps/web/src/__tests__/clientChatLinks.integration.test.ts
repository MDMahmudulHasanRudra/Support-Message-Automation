import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Client ⇄ WhatsApp chat links (CLIENT_CENTER_PLAN.md §3.4, stage 4B), in separate projects.
 *
 * What must hold:
 *   - linking and unlinking need `clients.link_whatsapp_chat` (an authorized admin's key, apart from
 *     `clients.update`), and the CLIENT_CENTER feature switch refuses them when off;
 *   - a link is manual and one chat at a time: only an individual chat the account ALREADY holds, never
 *     a group, never a typed number; a number that equals the client's is only SUGGESTED;
 *   - one active link per (account, chat), whatever two admins do at once, and a removed link is kept
 *     as history and frees the chat;
 *   - the client's timeline says a chat was linked without the number; nothing crosses projects.
 */

let current: Session;
const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const ids = { roles: [] as string[], users: [] as string[], projects: [] as string[] };

vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  requireSession: async () => current,
  getSession: async () => current,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/projectPaths", () => ({ projectPath: async (p: string) => `/p/x${p}`, inWorkspace: async () => false }));

const { runWithProject } = await import("@/server/projectContext");
const { forgetProjectFeatureStates } = await import("@/server/projectFeatures");
const clientActions = await import("@/server/actions/clients");
const actions = await import("@/server/actions/clientChatLinks");
const reads = await import("@/server/clientChatLinks");

type Project = { id: string; slug: string; name: string; status: "ACTIVE" };
let A: Project;
let B: Project;
let C: Project; // CLIENT_CENTER never switched on
const accounts = {} as Record<"a1" | "a2" | "b1", string>;

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
async function user(name: string, roleId: string): Promise<Session> {
  const u = await rawPrisma.user.create({ data: { username: `${name.toLowerCase()}_${tag}`, email: `${name.toLowerCase()}.${tag}@example.test`, name, passwordHash: "x", permissionModuleId: roleId } });
  ids.users.push(u.id);
  return { userId: u.id, username: u.username, email: u.email!, name } as Session;
}
const people = {} as Record<"admin" | "editor" | "viewer" | "mainAdmin", Session>;
const as = <T,>(person: Session, project: Project, fn: () => Promise<T>) => {
  current = person;
  return runWithProject(project, fn);
};
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const newClient = async (project: Project, name: string, whatsapp?: string) => (await as(people.admin, project, () => clientActions.createClient({}, form(whatsapp ? { name, whatsapp } : { name })))).clientId!;
const link = (person: Session, project: Project, clientId: string, accountId: string, chatId: string) => as(person, project, () => actions.linkWhatsAppChat(clientId, accountId, chatId));

async function chat(project: Project, accountId: string, chatId: string, senderName: string | null = null, groupId: string | null = null) {
  await rawPrisma.message.create({
    data: { projectId: project.id, accountId, groupId, chatId, whatsappMessageId: `wamid-${randomUUID()}`, senderPhone: chatId.split("@")[0]!, senderName, direction: "INCOMING", body: "hello", normalizedBody: "hello", timestampWa: new Date() },
  });
}

beforeAll(async () => {
  const keys = ["clients.view", "clients.create", "clients.update", "clients.archive", "clients.delete", "clients.link_whatsapp_chat", "messages.view"];
  people.admin = await user("Admin", await role("LK admin", keys));
  // Deleting a client is a Main Admin's alone (17 Oct 2026).
  people.mainAdmin = await user("MainAdmin", await role("main admin", ["clients.view", "projects.view", "projects.manage"]));
  people.editor = await user("Editor", await role("LK editor", ["clients.view", "clients.create", "clients.update", "messages.view"]));
  people.viewer = await user("Viewer", await role("LK viewer", ["clients.view", "messages.view"]));
  const make = async (name: string, withFeature: boolean) => {
    const p = await createProjectWithDefaults({ name: `${name} ${tag}`, slug: `${name.toLowerCase()}-${tag}`, status: "ACTIVE", creatorUserId: people.admin.userId }, rawPrisma);
    ids.projects.push(p.id);
    await rawPrisma.projectAccess.createMany({ data: Object.values(people).map((u) => ({ projectId: p.id, userId: u.userId })), skipDuplicates: true });
    if (withFeature) await rawPrisma.projectFeature.upsert({ where: { projectId_key: { projectId: p.id, key: "CLIENT_CENTER" } }, create: { projectId: p.id, key: "CLIENT_CENTER", enabled: true }, update: { enabled: true } });
    return { id: p.id, slug: p.slug, name: `${name} ${tag}`, status: "ACTIVE" as const };
  };
  A = await make("LinkA", true);
  B = await make("LinkB", true);
  C = await make("LinkC", false);
  accounts.a1 = (await rawPrisma.whatsAppAccount.create({ data: { projectId: A.id, label: `A one ${tag}`, status: "CONNECTED" } })).id;
  accounts.a2 = (await rawPrisma.whatsAppAccount.create({ data: { projectId: A.id, label: `A two ${tag}`, status: "CONNECTED" } })).id;
  accounts.b1 = (await rawPrisma.whatsAppAccount.create({ data: { projectId: B.id, label: `B one ${tag}`, status: "CONNECTED" } })).id;
  forgetProjectFeatureStates();
});

afterAll(async () => {
  const where = { projectId: { in: ids.projects } };
  await rawPrisma.clientWhatsAppChatLink.deleteMany({ where });
  await rawPrisma.message.deleteMany({ where });
  await rawPrisma.clientActivity.deleteMany({ where });
  await rawPrisma.clientChannel.deleteMany({ where });
  await rawPrisma.client.deleteMany({ where });
  await rawPrisma.whatsAppAccount.deleteMany({ where });
  await rawPrisma.systemLog.deleteMany({ where });
  await rawPrisma.projectFeature.deleteMany({ where });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: { in: ids.users } } });
  forgetProjectFeatureStates();
});

describe("1. permissions and the feature switch", () => {
  it("refuses linking and unlinking without clients.link_whatsapp_chat, even to someone who can edit the client", async () => {
    const clientId = await newClient(A, "Perm Client");
    await chat(A, accounts.a1, "8801700100001@c.us");
    for (const person of [people.editor, people.viewer]) {
      expect((await link(person, A, clientId, accounts.a1, "8801700100001@c.us")).ok).toBe(false);
      expect(await as(person, A, () => actions.searchLinkableChats(clientId, accounts.a1, ""))).toEqual([]);
    }
    expect(await rawPrisma.clientWhatsAppChatLink.count({ where: { clientId } })).toBe(0);
    expect((await link(people.admin, A, clientId, accounts.a1, "8801700100001@c.us")).ok).toBe(true);
    const row = await rawPrisma.clientWhatsAppChatLink.findFirstOrThrow({ where: { clientId } });
    expect((await as(people.editor, A, () => actions.unlinkWhatsAppChat(row.id))).ok).toBe(false);
    expect((await rawPrisma.clientWhatsAppChatLink.findUniqueOrThrow({ where: { id: row.id } })).unlinkedAt).toBeNull();
  });

  it("refuses everything in a project whose CLIENT_CENTER feature is off", async () => {
    const clientId = await newClient(A, "Feature Client");
    const r = await link(people.admin, C, clientId, accounts.a1, "8801700100002@c.us");
    expect(r.ok).toBe(false);
    expect(await rawPrisma.clientWhatsAppChatLink.count({ where: { projectId: C.id } })).toBe(0);
  });
});

describe("2. only an existing individual chat can be linked", () => {
  it("refuses a group, a broadcast and a malformed id", async () => {
    const clientId = await newClient(A, "Shape Client");
    for (const bad of ["12036302@g.us", "status@broadcast", "8801700100003", "@c.us"]) expect((await link(people.admin, A, clientId, accounts.a1, bad)).ok, bad).toBe(false);
    expect(await rawPrisma.clientWhatsAppChatLink.count({ where: { clientId } })).toBe(0);
  });

  it("refuses a number the account has no conversation with, and a chat that exists only on another account", async () => {
    const clientId = await newClient(A, "Existing Client");
    expect((await link(people.admin, A, clientId, accounts.a1, "8801700100004@c.us")).message).toMatch(/no stored conversation/);
    await chat(A, accounts.a2, "8801700100004@c.us");
    expect((await link(people.admin, A, clientId, accounts.a1, "8801700100004@c.us")).ok).toBe(false);
    expect((await link(people.admin, A, clientId, accounts.a2, "8801700100004@c.us")).ok).toBe(true);
  });

  it("does not count a group's messages as a personal chat", async () => {
    const clientId = await newClient(A, "Group Msg Client");
    const group = await rawPrisma.whatsAppGroup.create({ data: { projectId: A.id, accountId: accounts.a1, whatsappGroupId: `g-${tag}@g.us`, name: "G" } });
    await chat(A, accounts.a1, "8801700100005@c.us", null, group.id);
    expect((await link(people.admin, A, clientId, accounts.a1, "8801700100005@c.us")).ok).toBe(false);
  });

  it("rejects an account that is not this project's", async () => {
    const clientId = await newClient(A, "Other Account Client");
    await chat(B, accounts.b1, "8801700100006@c.us");
    expect((await link(people.admin, A, clientId, accounts.b1, "8801700100006@c.us")).message).toMatch(/not one of this project/);
  });
});

describe("3. one active link per chat", () => {
  it("refuses a chat already linked to another client, and to the same one", async () => {
    const one = await newClient(A, "Owner One");
    const two = await newClient(A, "Owner Two");
    await chat(A, accounts.a1, "8801700100007@c.us");
    expect((await link(people.admin, A, one, accounts.a1, "8801700100007@c.us")).ok).toBe(true);
    expect((await link(people.admin, A, two, accounts.a1, "8801700100007@c.us")).message).toMatch(/already linked to another client/);
    expect((await link(people.admin, A, one, accounts.a1, "8801700100007@c.us")).message).toMatch(/already linked to this client/);
    expect(await rawPrisma.clientWhatsAppChatLink.count({ where: { accountId: accounts.a1, chatId: "8801700100007@c.us", unlinkedAt: null } })).toBe(1);
  });

  it("lets the database decide when two admins link one chat at the same moment", async () => {
    const one = await newClient(A, "Race One");
    const two = await newClient(A, "Race Two");
    await chat(A, accounts.a1, "8801700100008@c.us");
    const results = await Promise.all([link(people.admin, A, one, accounts.a1, "8801700100008@c.us"), link(people.admin, A, two, accounts.a1, "8801700100008@c.us")]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await rawPrisma.clientWhatsAppChatLink.count({ where: { accountId: accounts.a1, chatId: "8801700100008@c.us", unlinkedAt: null } })).toBe(1);
  });

  it("keeps a removed link as history and frees the chat for another client", async () => {
    const one = await newClient(A, "Free One");
    const two = await newClient(A, "Free Two");
    await chat(A, accounts.a1, "8801700100009@c.us");
    await link(people.admin, A, one, accounts.a1, "8801700100009@c.us");
    const row = await rawPrisma.clientWhatsAppChatLink.findFirstOrThrow({ where: { clientId: one } });
    expect((await as(people.admin, A, () => actions.unlinkWhatsAppChat(row.id))).ok).toBe(true);
    expect((await as(people.admin, A, () => actions.unlinkWhatsAppChat(row.id))).ok).toBe(false);
    const kept = await rawPrisma.clientWhatsAppChatLink.findUniqueOrThrow({ where: { id: row.id } });
    expect(kept.unlinkedAt).not.toBeNull();
    expect(kept.unlinkedById).toBe(people.admin.userId);
    expect((await link(people.admin, A, two, accounts.a1, "8801700100009@c.us")).ok).toBe(true);
    expect((await as(people.admin, A, () => reads.getClientChatLinks(one)))).toEqual([]);
  });

  it("makes the database itself refuse a second active link and a group id", async () => {
    const one = await newClient(A, "Db One");
    const two = await newClient(A, "Db Two");
    await rawPrisma.clientWhatsAppChatLink.create({ data: { projectId: A.id, clientId: one, accountId: accounts.a1, chatId: "8801700100010@c.us" } });
    await expect(rawPrisma.clientWhatsAppChatLink.create({ data: { projectId: A.id, clientId: two, accountId: accounts.a1, chatId: "8801700100010@c.us" } })).rejects.toThrow();
    await expect(rawPrisma.clientWhatsAppChatLink.create({ data: { projectId: A.id, clientId: two, accountId: accounts.a1, chatId: "12036302@g.us" } })).rejects.toThrow();
  });
});

describe("4. suggestions are never links", () => {
  it("marks the chat whose number equals the client's WhatsApp number and links nothing", async () => {
    const clientId = await newClient(A, "Suggest Client", "+880 1700 100011");
    await chat(A, accounts.a1, "8801700100011@c.us", "Karim");
    await chat(A, accounts.a1, "8801700100012@c.us", "Someone Else");
    const found = await as(people.admin, A, () => actions.searchLinkableChats(clientId, accounts.a1, ""));
    expect(found.find((c) => c.chatId === "8801700100011@c.us")).toMatchObject({ suggested: true, label: "Karim" });
    expect(found.find((c) => c.chatId === "8801700100012@c.us")?.suggested).toBe(false);
    expect(found[0]!.chatId).toBe("8801700100011@c.us");
    expect(await rawPrisma.clientWhatsAppChatLink.count({ where: { clientId } })).toBe(0);
  });

  it("still offers a suggestion that a narrower search would have hidden, and shows who a chat is already linked to", async () => {
    const owner = await newClient(A, "Linked Owner");
    const clientId = await newClient(A, "Hidden Suggest", "+8801700100013");
    await chat(A, accounts.a1, "8801700100013@c.us", "Rina");
    await link(people.admin, A, owner, accounts.a1, "8801700100013@c.us");
    const found = await as(people.admin, A, () => actions.searchLinkableChats(clientId, accounts.a1, "zzz-no-match"));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ chatId: "8801700100013@c.us", suggested: true, linkedTo: { name: "Linked Owner" } });
  });

  it("never suggests a hidden-number chat, but lists it for a deliberate link", async () => {
    const clientId = await newClient(A, "Lid Client", "+8801700100014");
    await chat(A, accounts.a1, "8801700100014@lid", "Hidden Person");
    const found = await as(people.admin, A, () => actions.searchLinkableChats(clientId, accounts.a1, "Hidden"));
    expect(found.find((c) => c.chatId === "8801700100014@lid")?.suggested).toBe(false);
    expect((await link(people.admin, A, clientId, accounts.a1, "8801700100014@lid")).ok).toBe(true);
  });
});

describe("5. timeline, archived clients and deletion", () => {
  it("records that a chat was linked and removed, without the number", async () => {
    const clientId = await newClient(A, "Timeline Client");
    await chat(A, accounts.a1, "8801700199999@c.us");
    await link(people.admin, A, clientId, accounts.a1, "8801700199999@c.us");
    const row = await rawPrisma.clientWhatsAppChatLink.findFirstOrThrow({ where: { clientId } });
    await as(people.admin, A, () => actions.unlinkWhatsAppChat(row.id));
    const activities = await rawPrisma.clientActivity.findMany({ where: { clientId, type: { in: ["CHAT_LINKED", "CHAT_UNLINKED"] } }, orderBy: { createdAt: "asc" } });
    expect(activities.map((a) => a.type)).toEqual(["CHAT_LINKED", "CHAT_UNLINKED"]);
    expect(JSON.stringify(activities)).not.toMatch(/880170019/);
    const logs = await rawPrisma.systemLog.findMany({ where: { projectId: A.id, scope: "clients", targetId: clientId } });
    expect(logs.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(logs)).not.toMatch(/880170019/);
  });

  it("refuses to link for an archived client, and deleting a client removes its links", async () => {
    const clientId = await newClient(A, "Archive Client");
    await chat(A, accounts.a1, "8801700100015@c.us");
    await as(people.admin, A, () => clientActions.archiveClients([clientId]));
    expect((await link(people.admin, A, clientId, accounts.a1, "8801700100015@c.us")).message).toMatch(/archived/);
    await as(people.admin, A, () => clientActions.restoreClients([clientId]));
    await link(people.admin, A, clientId, accounts.a1, "8801700100015@c.us");
    await as(people.admin, A, () => clientActions.archiveClients([clientId]));
    expect((await as(people.mainAdmin, A, () => clientActions.deleteClients([clientId]))).ok).toBe(true);
    expect(await rawPrisma.clientWhatsAppChatLink.count({ where: { clientId } })).toBe(0);
  });
});

describe("6. project isolation", () => {
  it("does not let another project see, link or remove a link", async () => {
    const clientId = await newClient(A, "Iso Client");
    await chat(A, accounts.a1, "8801700100016@c.us");
    await link(people.admin, A, clientId, accounts.a1, "8801700100016@c.us");
    const row = await rawPrisma.clientWhatsAppChatLink.findFirstOrThrow({ where: { clientId } });
    expect((await link(people.admin, B, clientId, accounts.b1, "8801700100016@c.us")).ok).toBe(false);
    expect(await as(people.admin, B, () => actions.searchLinkableChats(clientId, accounts.a1, ""))).toEqual([]);
    expect((await as(people.admin, B, () => actions.unlinkWhatsAppChat(row.id))).ok).toBe(false);
    expect((await as(people.admin, B, () => reads.getClientChatLinks(clientId)))).toEqual([]);
    expect((await rawPrisma.clientWhatsAppChatLink.findUniqueOrThrow({ where: { id: row.id } })).unlinkedAt).toBeNull();
  });

  it("makes the database refuse a link whose client or account is in another project", async () => {
    const clientId = await newClient(A, "Trigger Client");
    await expect(rawPrisma.clientWhatsAppChatLink.create({ data: { projectId: B.id, clientId, accountId: accounts.b1, chatId: "8801700100017@c.us" } })).rejects.toThrow();
    await expect(rawPrisma.clientWhatsAppChatLink.create({ data: { projectId: A.id, clientId, accountId: accounts.b1, chatId: "8801700100017@c.us" } })).rejects.toThrow();
    expect(await rawPrisma.clientWhatsAppChatLink.count({ where: { clientId } })).toBe(0);
  });
});
