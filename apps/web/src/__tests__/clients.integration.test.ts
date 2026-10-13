import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Client Management (CLIENT_CENTER.md), Phase 2: the records, their actions and the rules around
 * them — in two fresh projects, so neither can see the other's clients.
 *
 * What must hold:
 *   - every action refuses without its own permission key, and refuses entirely when the project
 *     does not have the CLIENT_CENTER feature (it ships off);
 *   - a client is found, listed and changed only inside its own project, whatever id is posted;
 *   - the same phone / email / client code written another way is shown as a possible duplicate BEFORE
 *     a second client is created, and nothing is ever merged;
 *   - archiving keeps everything and restoring brings the previous status back; only an ARCHIVED
 *     client can be permanently deleted, and that needs its own key;
 *   - the timeline records what happened without carrying a note's text, and notes stay internal.
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
const actions = await import("@/server/actions/clients");
const reads = await import("@/server/clients");
const { parseClientFilters } = await import("@/lib/clientFilters");

type Project = { id: string; slug: string; name: string; status: "ACTIVE" };
let A: Project;
let B: Project;
let C: Project; // the CLIENT_CENTER feature is never switched on here

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
const people = {} as Record<"manager" | "editor" | "viewer" | "outsider", Session>;
const as = <T,>(person: Session, project: Project, fn: () => Promise<T>) => {
  current = person;
  return runWithProject(project, fn);
};
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const create = (person: Session, project: Project, fields: Record<string, string>) => as(person, project, () => actions.createClient({}, form(fields)));
const idOf = (r: { clientId?: string }) => r.clientId!;

beforeAll(async () => {
  const everything = ["clients.view", "clients.create", "clients.update", "clients.archive", "clients.delete", "clients.import", "clients.export", "messages.view"];
  people.manager = await user("Manager", await role("CL manager", everything));
  people.editor = await user("Editor", await role("CL editor", ["clients.view", "clients.create", "clients.update", "messages.view"]));
  people.viewer = await user("Viewer", await role("CL viewer", ["clients.view", "messages.view"]));
  people.outsider = await user("Outsider", await role("CL outsider", ["messages.view"]));
  const make = async (name: string, withFeature: boolean) => {
    const p = await createProjectWithDefaults({ name: `${name} ${tag}`, slug: `${name.toLowerCase()}-${tag}`, status: "ACTIVE", creatorUserId: people.manager.userId }, rawPrisma);
    ids.projects.push(p.id);
    await rawPrisma.projectAccess.createMany({ data: Object.values(people).map((u) => ({ projectId: p.id, userId: u.userId })), skipDuplicates: true });
    if (withFeature) await rawPrisma.projectFeature.upsert({ where: { projectId_key: { projectId: p.id, key: "CLIENT_CENTER" } }, create: { projectId: p.id, key: "CLIENT_CENTER", enabled: true }, update: { enabled: true } });
    return { id: p.id, slug: p.slug, name: `${name} ${tag}`, status: "ACTIVE" as const };
  };
  A = await make("ClientsA", true);
  B = await make("ClientsB", true);
  C = await make("ClientsC", false);
  forgetProjectFeatureStates();
});

afterAll(async () => {
  const where = { projectId: { in: ids.projects } };
  await rawPrisma.clientActivity.deleteMany({ where });
  await rawPrisma.clientNote.deleteMany({ where });
  await rawPrisma.clientChannel.deleteMany({ where });
  await rawPrisma.client.deleteMany({ where });
  await rawPrisma.clientImportJob.deleteMany({ where });
  await rawPrisma.systemLog.deleteMany({ where });
  await rawPrisma.projectFeature.deleteMany({ where });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: { in: ids.users } } });
  forgetProjectFeatureStates();
});

describe("1. permissions and the feature switch", () => {
  it("refuses each action without its own key", async () => {
    const fields = { name: "Nobody" };
    expect((await create(people.viewer, A, fields)).error).toMatch(/permission/i);
    expect((await create(people.outsider, A, fields)).error).toMatch(/permission/i);
    const made = await create(people.manager, A, { name: "Perm Test", phone: "+8801700000001" });
    expect(made.success).toBe(true);
    const id = idOf(made);
    // an editor may edit but not archive or delete; a viewer may do none of it
    expect((await as(people.editor, A, () => actions.archiveClients([id]))).ok).toBe(false);
    expect((await as(people.viewer, A, () => actions.bulkSetClientStatus([id], "INACTIVE"))).ok).toBe(false);
    expect((await as(people.viewer, A, () => actions.addClientNote(id, {}, form({ body: "x" })))).error).toMatch(/permission/i);
    expect((await as(people.editor, A, () => actions.deleteClients([id]))).ok).toBe(false);
    expect(await rawPrisma.client.findUnique({ where: { id }, select: { status: true } })).toMatchObject({ status: "ACTIVE" });
  });

  it("refuses everything in a project whose CLIENT_CENTER feature is off", async () => {
    const refused = await create(people.manager, C, { name: "Feature Off" });
    expect(refused.error).toBeTruthy();
    expect(await rawPrisma.client.count({ where: { projectId: C.id } })).toBe(0);
    expect((await as(people.manager, C, () => actions.selectAllMatchingClientIds({}))).ids).toEqual([]);
  });
});

describe("2. create, edit, search and filter", () => {
  it("creates a client with a generated code, normalised channels and a timeline entry", async () => {
    const r = await create(people.manager, A, {
      name: "  Rahim Traders  ",
      companyName: "Rahim & Sons",
      phone: "01894-431220",
      whatsapp: "+880 1894 431220",
      email: "Rahim@Example.COM",
      category: "Corporate",
      tags: "VIP, vip, Dhaka",
    });
    expect(r.success).toBe(true);
    const client = await rawPrisma.client.findUniqueOrThrow({ where: { id: idOf(r) }, include: { channels: true, activities: true } });
    expect(client).toMatchObject({ name: "Rahim Traders", status: "ACTIVE", source: "MANUAL", projectId: A.id, tags: ["vip", "dhaka"] });
    expect(client.code).toMatch(/^CL-\d{6}$/);
    expect(client.channels.map((c) => `${c.kind}:${c.normalizedValue}`).sort()).toEqual(["EMAIL:rahim@example.com", "PHONE:8801894431220", "WHATSAPP:8801894431220"]);
    expect(client.channels.every((c) => c.consentStatus === "UNKNOWN")).toBe(true);
    expect(client.activities.map((a) => a.type)).toEqual(["CREATED"]);
  });

  it("validates: a name is required, a bad phone / status / code is refused, nothing is saved", async () => {
    const before = await rawPrisma.client.count({ where: { projectId: A.id } });
    expect((await create(people.manager, A, { name: "" })).error).toMatch(/needs a name/);
    expect((await create(people.manager, A, { name: "X", phone: "call me" })).error).toMatch(/not a valid phone/);
    expect((await create(people.manager, A, { name: "X", status: "VIP" })).error).toMatch(/status is not recognised/);
    expect((await create(people.manager, A, { name: "X", code: "bad code!" })).error).toMatch(/client code/);
    expect((await create(people.manager, A, { name: "X", status: "ARCHIVED" })).error).toMatch(/cannot start archived/);
    expect(await rawPrisma.client.count({ where: { projectId: A.id } })).toBe(before);
  });

  it("edits fields and records what changed (names of fields, not values)", async () => {
    const id = idOf(await create(people.manager, A, { name: "Edit Me", category: "Retail" }));
    const r = await as(people.editor, A, () => actions.updateClient(id, {}, form({ name: "Edited", category: "Wholesale", status: "PENDING", tags: "a,b" })));
    expect(r.success).toBe(true);
    const row = await rawPrisma.client.findUniqueOrThrow({ where: { id }, include: { activities: { orderBy: { createdAt: "asc" } } } });
    expect(row).toMatchObject({ name: "Edited", category: "Wholesale", status: "PENDING", tags: ["a", "b"] });
    const summaries = row.activities.map((a) => a.summary).join(" | ");
    expect(summaries).toMatch(/Updated name, category/);
    expect(summaries).toMatch(/Status changed from ACTIVE to PENDING/);
    expect(summaries).not.toMatch(/Wholesale/);
  });

  it("searches by name, code, company and a phone written any way; filters by tag, status and assignee", async () => {
    const run = async (params: Record<string, string>) => {
      const r = await as(people.viewer, A, () => reads.listClients({ filters: parseClientFilters(params), sort: "name", dir: "asc", page: 1, pageSize: 50 }));
      return r.clients.map((c) => c.name);
    };
    await create(people.manager, A, { name: "Searchable Karim", companyName: "Karim Telecom", phone: "+8801911111111", tags: "findme" });
    expect(await run({ q: "karim telecom" })).toContain("Searchable Karim");
    expect(await run({ q: "01911-111111" })).toContain("Searchable Karim"); // local form, with a separator
    expect(await run({ q: "+880 1911 111111" })).toContain("Searchable Karim");
    expect(await run({ tag: "findme" })).toEqual(["Searchable Karim"]);
    expect(await run({ status: "PENDING" })).toContain("Edited");
    expect(await run({ assigned: "none", tag: "findme" })).toEqual(["Searchable Karim"]);
    expect(await run({ q: "zzz-no-such-client" })).toEqual([]);
  });

  it("paginates on the server and keeps a stable order", async () => {
    for (let i = 0; i < 7; i++) await create(people.manager, A, { name: `Page Client ${String(i).padStart(2, "0")}`, tags: "paged" });
    const read = (page: number) => as(people.viewer, A, () => reads.listClients({ filters: parseClientFilters({ tag: "paged" }), sort: "name", dir: "asc", page, pageSize: 25 }));
    const page1 = await read(1);
    expect(page1.total).toBe(7);
    const small = await as(people.viewer, A, () => reads.listClients({ filters: parseClientFilters({ tag: "paged" }), sort: "name", dir: "asc", page: 2, pageSize: 5 }));
    expect(small.clients.map((c) => c.name)).toEqual(["Page Client 05", "Page Client 06"]);
  });
});

describe("3. duplicates are shown first, and nothing is merged", () => {
  it("flags the same phone written another way, the same email, and the same code — before creating", async () => {
    const original = await create(people.manager, A, { name: "Original Client", phone: "+8801822222222", email: "orig@example.com", code: `ORIG-${tag}` });
    expect(original.success).toBe(true);

    const byPhone = await create(people.manager, A, { name: "Second Entry", whatsapp: "01822-222222" });
    expect(byPhone.success).toBeUndefined();
    expect(byPhone.duplicates?.map((d) => d.name)).toEqual(["Original Client"]);
    expect(byPhone.duplicates?.[0]?.sharedKeys).toEqual(["phone:8801822222222"]);

    const byEmail = await create(people.manager, A, { name: "Third Entry", email: "ORIG@example.com" });
    expect(byEmail.duplicates?.[0]?.sharedKeys).toEqual(["email:orig@example.com"]);

    const byCode = await create(people.manager, A, { name: "Fourth Entry", code: `orig-${tag}` });
    expect(byCode.duplicates?.[0]?.sharedKeys).toContain("code");

    expect(await rawPrisma.client.count({ where: { projectId: A.id, name: { in: ["Second Entry", "Third Entry"] } } })).toBe(0);
  });

  it("creates the second client only when told to, and still merges nothing", async () => {
    const forced = await as(people.manager, A, () => actions.createClient({}, form({ name: "Second Entry Forced", phone: "01822222222", confirmDuplicate: "1" })));
    expect(forced.success).toBe(true);
    const both = await rawPrisma.client.findMany({ where: { projectId: A.id, channels: { some: { normalizedValue: "8801822222222" } } } });
    expect(both).toHaveLength(2);
    const detail = await as(people.viewer, A, () => reads.getClientDetail(idOf(forced)));
    expect(detail?.duplicates.map((d) => d.name)).toEqual(["Original Client"]);
  });

  it("does not treat a similar NAME as a duplicate", async () => {
    const r = await create(people.manager, A, { name: "Original Client" });
    expect(r.success).toBe(true);
  });
});

describe("4. project isolation", () => {
  it("never shows, matches, changes or deletes another project's client", async () => {
    const inB = idOf(await create(people.manager, B, { name: "Only In B", phone: "+8801733333333", code: `BONLY-${tag}` }));
    // not in A's list or search, and its phone does not make A's new entry a duplicate
    const listA = await as(people.manager, A, () => reads.listClients({ filters: parseClientFilters({ q: "Only In B" }), sort: "name", dir: "asc", page: 1, pageSize: 50 }));
    expect(listA.total).toBe(0);
    const same = await create(people.manager, A, { name: "Same Phone As B", phone: "+8801733333333", code: `BONLY-${tag}` });
    expect(same.success).toBe(true);
    // by id, from A
    expect(await as(people.manager, A, () => reads.getClientDetail(inB))).toBeNull();
    expect((await as(people.manager, A, () => actions.updateClient(inB, {}, form({ name: "Hijacked" })))).error).toMatch(/no longer exists/);
    expect((await as(people.manager, A, () => actions.addClientNote(inB, {}, form({ body: "x" })))).error).toMatch(/no longer exists/);
    expect((await as(people.manager, A, () => actions.archiveClients([inB]))).message).toMatch(/Nothing to archive/);
    expect((await as(people.manager, A, () => actions.bulkTagClients([inB], "leak", ""))).message).toMatch(/0 updated/);
    expect((await as(people.manager, A, () => actions.deleteClients([inB]))).ok).toBe(false);
    expect(await rawPrisma.client.findUniqueOrThrow({ where: { id: inB } })).toMatchObject({ name: "Only In B", status: "ACTIVE", tags: [], projectId: B.id });
  });

  it("refuses to assign a staff member or team from another project", async () => {
    const otherMember = await rawPrisma.internalTeamMember.create({ data: { projectId: B.id, name: "B Staff", phoneNumber: `+88017${Math.floor(Math.random() * 1e8)}`, role: "Support" } });
    const r = await create(people.manager, A, { name: "Wrong Assignee", assignedMemberId: otherMember.id });
    expect(r.error).toMatch(/does not exist in this project/);
    await rawPrisma.internalTeamMember.delete({ where: { id: otherMember.id } });
  });

  it("the database itself refuses a channel whose client is in another project", async () => {
    const inB = idOf(await create(people.manager, B, { name: "Trigger Target" }));
    await expect(
      rawPrisma.clientChannel.create({ data: { projectId: A.id, clientId: inB, kind: "PHONE", value: "x", normalizedValue: "8801700009999" } }),
    ).rejects.toThrow();
  });
});

describe("5. archive, restore, delete, notes, channels, consent", () => {
  it("archives without losing anything, restores the previous status, and deletes only archived clients", async () => {
    const id = idOf(await create(people.manager, A, { name: "Life Cycle", status: "PENDING", phone: "+8801744444444" }));
    await as(people.manager, A, () => actions.addClientNote(id, {}, form({ body: "secret internal note" })));

    expect((await as(people.manager, A, () => actions.deleteClients([id]))).message).toMatch(/Only archived/);
    expect((await as(people.manager, A, () => actions.archiveClients([id]))).ok).toBe(true);
    let row = await rawPrisma.client.findUniqueOrThrow({ where: { id }, include: { channels: true, notes: true } });
    expect(row).toMatchObject({ status: "ARCHIVED" });
    expect(row.archivedAt).not.toBeNull();
    expect(row.channels).toHaveLength(1);
    expect(row.notes).toHaveLength(1);

    // an archived client is hidden from the default list and cannot be edited
    const hidden = await as(people.viewer, A, () => reads.listClients({ filters: parseClientFilters({ q: "Life Cycle" }), sort: "name", dir: "asc", page: 1, pageSize: 50 }));
    expect(hidden.total).toBe(0);
    expect((await as(people.manager, A, () => actions.updateClient(id, {}, form({ name: "Nope" })))).error).toMatch(/Restore this client/);

    expect((await as(people.manager, A, () => actions.restoreClients([id]))).message).toMatch(/1 restored/);
    row = await rawPrisma.client.findUniqueOrThrow({ where: { id }, include: { channels: true, notes: true } });
    expect(row).toMatchObject({ status: "PENDING", archivedAt: null });

    await as(people.manager, A, () => actions.archiveClients([id]));
    const gone = await as(people.manager, A, () => actions.deleteClients([id]));
    expect(gone.ok).toBe(true);
    expect(await rawPrisma.client.count({ where: { id } })).toBe(0);
    expect(await rawPrisma.clientChannel.count({ where: { clientId: id } })).toBe(0);
    // the deletion is on record, with a code and a count but no name or contact detail
    const log = await rawPrisma.systemLog.findFirst({ where: { projectId: A.id, scope: "clients" }, orderBy: { createdAt: "desc" } });
    expect(log?.message).toMatch(/Permanently deleted 1 client/);
    expect(JSON.stringify(log?.metadata)).not.toMatch(/Life Cycle|8801744444444/);
  });

  it("keeps notes internal and out of the timeline text", async () => {
    const id = idOf(await create(people.manager, A, { name: "Notes Client" }));
    await as(people.editor, A, () => actions.addClientNote(id, {}, form({ body: "call back after Eid" })));
    const detail = await as(people.viewer, A, () => reads.getClientDetail(id));
    expect(detail?.notes.map((n) => n.body)).toEqual(["call back after Eid"]);
    expect(detail?.activities.map((a) => a.summary).join(" ")).not.toMatch(/Eid/);
    expect((await as(people.editor, A, () => actions.addClientNote(id, {}, form({ body: "   " })))).error).toMatch(/Write the note/);
  });

  it("adds a channel (warning about another client's), keeps one primary per kind, and records consent per channel", async () => {
    const id = idOf(await create(people.manager, A, { name: "Channel Client", phone: "+8801755555555" }));
    const added = await as(people.editor, A, () => actions.addClientChannel(id, {}, form({ kind: "INSTAGRAM", value: "@Channel_Client" })));
    expect(added.success).toBe(true);
    expect((await rawPrisma.clientChannel.findFirstOrThrow({ where: { clientId: id, kind: "INSTAGRAM" } })).normalizedValue).toBe("channel_client");
    expect((await as(people.editor, A, () => actions.addClientChannel(id, {}, form({ kind: "INSTAGRAM", value: "channel_client" })))).error).toBeTruthy();

    const other = await create(people.manager, A, { name: "Has That Email", email: "shared@example.com" });
    const warned = await as(people.editor, A, () => actions.addClientChannel(id, {}, form({ kind: "EMAIL", value: "shared@example.com" })));
    expect(warned.duplicates?.map((d) => d.name)).toEqual(["Has That Email"]);
    expect(other.success).toBe(true);

    const phone = await rawPrisma.clientChannel.findFirstOrThrow({ where: { clientId: id, kind: "PHONE" } });
    const ig = await rawPrisma.clientChannel.findFirstOrThrow({ where: { clientId: id, kind: "INSTAGRAM" } });
    expect((await as(people.editor, A, () => actions.setClientChannelConsent(ig.id, "OPTED_OUT", "asked to stop"))).ok).toBe(true);
    const after = await rawPrisma.clientChannel.findMany({ where: { clientId: id } });
    expect(after.find((c) => c.id === ig.id)).toMatchObject({ consentStatus: "OPTED_OUT", consentSource: "recorded by staff", consentNote: "asked to stop" });
    expect(after.find((c) => c.id === phone.id)).toMatchObject({ consentStatus: "UNKNOWN" }); // another channel is untouched
    expect((await as(people.editor, A, () => actions.setClientChannelConsent(ig.id, "MAYBE"))).ok).toBe(false);
    expect((await as(people.viewer, A, () => actions.removeClientChannel(ig.id))).ok).toBe(false);
  });

  it("bulk actions report counts, skip archived clients and never exceed the caller's project", async () => {
    const a = idOf(await create(people.manager, A, { name: "Bulk One", tags: "keep" }));
    const b = idOf(await create(people.manager, A, { name: "Bulk Two" }));
    const tagged = await as(people.editor, A, () => actions.bulkTagClients([a, b], "Promo, keep", ""));
    expect(tagged.message).toMatch(/2 updated|1 updated/);
    expect((await rawPrisma.client.findUniqueOrThrow({ where: { id: a } })).tags).toEqual(["keep", "promo"]);
    const removed = await as(people.editor, A, () => actions.bulkTagClients([a, b], "", "promo"));
    expect(removed.ok).toBe(true);
    expect((await rawPrisma.client.findUniqueOrThrow({ where: { id: b } })).tags).toEqual(["keep"]);
    expect((await as(people.editor, A, () => actions.bulkSetClientStatus([a, b], "ARCHIVED"))).ok).toBe(false);
    expect((await as(people.editor, A, () => actions.bulkSetClientStatus([a, b], "BLOCKED"))).message).toMatch(/2 set to blocked/);
    expect((await as(people.editor, A, () => actions.bulkTagClients([], "x", ""))).ok).toBe(false);
    const all = await as(people.viewer, A, () => actions.selectAllMatchingClientIds({ q: "Bulk" }));
    expect(all.ids.sort()).toEqual([a, b].sort());
  });
});
