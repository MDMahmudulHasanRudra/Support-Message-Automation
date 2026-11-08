import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * The All projects inbox (ALL_PROJECTS_INBOX.md). One list across a person's projects, and nothing they could not already
 * read: a project they cannot enter, a project with the module off, a role that cannot read, and another customer are out.
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
vi.mock("@/server/projectPaths", () => ({ projectPath: async (p: string) => p, inWorkspace: async () => false }));

const { forgetProjectFeatureStates } = await import("@/server/projectFeatures");
const { forgetUniversalReadings, loadUniversalInbox, universalInboxProjects, universalItemPath, mergeInboxOptions } = await import("@/server/universalInbox");
const actions = await import("@/server/actions/universalInbox");

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const fx = {} as { a: string; b: string; c: string; other: string; customer: string; convA: string; convB: string; convC: string; convOther: string };
const ids = { users: [] as string[], roles: [] as string[] };
const s = {} as Record<"both" | "onlyA" | "cannotRead", Session>;

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
  return { userId: u.id, username: u.username, email: u.email!, name, tenant: null } as unknown as Session;
}
async function feature(projectId: string, key: string, enabled: boolean) {
  await rawPrisma.projectFeature.upsert({ where: { projectId_key: { projectId, key } }, create: { projectId, key, enabled }, update: { enabled } });
  forgetProjectFeatureStates();
}
async function project(name: string, customerId: string | null = null) {
  const created = await createProjectWithDefaults({ name: `${name} ${tag}`, slug: `${name.toLowerCase()}-${tag}`, status: "ACTIVE", creatorUserId: null, ...(customerId ? { customerId } : {}) }, rawPrisma);
  const connection = await rawPrisma.channelConnection.create({ data: { projectId: created.id, type: "TELEGRAM", name: `@${name}`, status: "CONNECTED", webhookKey: `uw-${name}-${tag}` } });
  const conversation = await rawPrisma.channelConversation.create({
    data: { projectId: created.id, connectionId: connection.id, type: "TELEGRAM", externalThreadId: `t-${name}-${tag}`, title: `Customer of ${name}`, lastMessageAt: new Date() },
  });
  await feature(created.id, "OMNICHANNEL", true);
  return { id: created.id, conversation: conversation.id };
}
const titles = (r: { items: Array<{ title: string }> }) => r.items.map((i) => i.title);
const fresh = () => {
  for (const u of ids.users) forgetUniversalReadings(u);
};

beforeAll(async () => {
  const a = await project("Alpha");
  const b = await project("Beta");
  const c = await project("Gamma");
  fx.customer = (await rawPrisma.customer.create({ data: { name: `Other ${tag}` } })).id;
  const other = await project("Outside", fx.customer);
  Object.assign(fx, { a: a.id, b: b.id, c: c.id, other: other.id, convA: a.conversation, convB: b.conversation, convC: c.conversation, convOther: other.conversation });

  const reader = await role("U reader", ["messages.view", "messages.reply", "conversations.reply"]);
  const noRead = await role("U none", ["clients.view"]);
  s.both = await user("u_both", reader, [fx.a, fx.b]);
  s.onlyA = await user("u_only", reader, [fx.a]);
  s.cannotRead = await user("u_none", noRead, [fx.a, fx.b]);
});

beforeEach(async () => {
  await feature(fx.b, "OMNICHANNEL", true);
  fresh();
  current = s.both;
});

afterAll(async () => {
  const tables = (await rawPrisma.$queryRaw<Array<{ table_name: string }>>`SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`).map((t) => t.table_name);
  for (const id of [fx.a, fx.b, fx.c, fx.other]) {
    for (let pass = 0; pass < 4; pass++) for (const t of tables) await rawPrisma.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "projectId" = $1`, id).catch(() => undefined);
    await rawPrisma.project.deleteMany({ where: { id } });
  }
  await rawPrisma.user.deleteMany({ where: { id: { in: ids.users } } });
  await rawPrisma.permissionModule.deleteMany({ where: { id: { in: ids.roles } } });
  await rawPrisma.customer.deleteMany({ where: { id: fx.customer } });
});

describe("the list", () => {
  it("holds every project the person can read, each row marked with its own", async () => {
    const r = await loadUniversalInbox(s.both, { withOptions: true });
    expect(titles(r).sort()).toEqual([`Customer of Alpha`, `Customer of Beta`]);
    const alpha = r.items.find((i) => i.title === "Customer of Alpha")!;
    expect(alpha.projectSlug).toBe(`alpha-${tag}`);
    expect(alpha.href).toBe(`/conversations/all-projects/c/${fx.convA}`);
    expect(r.projects.map((p) => p.slug).sort()).toEqual([`alpha-${tag}`, `beta-${tag}`]);
    expect(r.counts.all).toBe(r.projects.reduce((n, p) => n + p.counts.all, 0));
  });

  it("never holds a project the person cannot enter", async () => {
    current = s.onlyA;
    const r = await loadUniversalInbox(s.onlyA);
    expect(titles(r)).toEqual(["Customer of Alpha"]);
  });

  it("leaves out a project with the inbox module off", async () => {
    await feature(fx.b, "OMNICHANNEL", false);
    fresh();
    expect(titles(await loadUniversalInbox(s.both))).toEqual(["Customer of Alpha"]);
  });

  it("is empty for a role that cannot read conversations", async () => {
    current = s.cannotRead;
    expect(await universalInboxProjects(s.cannotRead)).toEqual([]);
    expect((await loadUniversalInbox(s.cannotRead)).items).toEqual([]);
  });

  it("a Main Admin sees every project of their own customer and none of another's", async () => {
    const admin = await role("U admin", ["messages.view", "projects.manage"]);
    const main = await user("u_main", admin, []);
    current = main;
    const r = await loadUniversalInbox(main);
    expect(titles(r)).toEqual(expect.arrayContaining(["Customer of Alpha", "Customer of Beta", "Customer of Gamma"]));
    expect(titles(r)).not.toContain("Customer of Outside");
  });

  it("reaches every kind of conversation at its address in this inbox", () => {
    expect(universalItemPath("/chat/account/a1/g1")).toBe("/conversations/all-projects/w/a1/g1");
    expect(universalItemPath("/conversations/all/c/x")).toBe("/conversations/all-projects/c/x");
  });

  it("the filters say whose a Team is", () => {
    const opts = (name: string, teams: Array<{ id: string; name: string }>) => ({ slug: name, name, status: "ACTIVE", colorIndex: 0, counts: {} as never, lastMessageAt: null, problems: 0, options: { teams, accounts: [], people: [{ id: "p1", name: "Same" }], collaboration: true, lifecycle: false, moodDetection: false, autoRouting: true, canShare: true } });
    const merged = mergeInboxOptions([opts("One", [{ id: "t1", name: "Billing" }]), opts("Two", [{ id: "t2", name: "Billing" }])]);
    expect(merged.teams.map((t) => t.name)).toEqual(["One · Billing", "Two · Billing"]);
    expect(merged.people).toHaveLength(1);
    expect(merged.autoRouting).toBe(false);
  });
});

describe("the actions", () => {
  it("listing needs a session", async () => {
    current = null;
    expect(await actions.listUniversalInboxAction({ channel: "all" })).toBeNull();
  });

  it("listing answers only for the person asking", async () => {
    current = s.onlyA;
    const r = await actions.listUniversalInboxAction({ channel: "telegram" });
    expect(r && titles(r)).toEqual(["Customer of Alpha"]);
  });

  it("a change reaches conversations in two projects", async () => {
    await feature(fx.a, "INBOX_COLLABORATION", true);
    await feature(fx.b, "INBOX_COLLABORATION", true);
    const r = await actions.bulkUpdateAcrossProjects(
      [
        { projectSlug: `alpha-${tag}`, refs: [{ kind: "channel", conversationId: fx.convA }] },
        { projectSlug: `beta-${tag}`, refs: [{ kind: "channel", conversationId: fx.convB }] },
      ],
      { op: "priority", value: "HIGH" },
    );
    expect(r).toMatchObject({ changed: 2 });
  });

  it("refuses a project the person cannot use, whatever the request names", async () => {
    current = s.onlyA;
    const r = await actions.bulkUpdateAcrossProjects([{ projectSlug: `beta-${tag}`, refs: [{ kind: "channel", conversationId: fx.convB }] }], { op: "priority", value: "URGENT" });
    expect(r).toEqual({ error: expect.stringContaining("not in a project you can use") });
    const label = await rawPrisma.conversationLabel.findFirst({ where: { channelConversationId: fx.convB } });
    expect(label?.priority).not.toBe("URGENT");
  });

  it("a conversation of one project named under another is not changed", async () => {
    await feature(fx.c, "INBOX_COLLABORATION", true);
    const r = await actions.bulkUpdateAcrossProjects([{ projectSlug: `alpha-${tag}`, refs: [{ kind: "channel", conversationId: fx.convC }] }], { op: "priority", value: "URGENT" });
    expect("error" in r ? 0 : r.changed).toBe(0);
    expect(await rawPrisma.conversationLabel.count({ where: { channelConversationId: fx.convC } })).toBe(0);
  });
});
