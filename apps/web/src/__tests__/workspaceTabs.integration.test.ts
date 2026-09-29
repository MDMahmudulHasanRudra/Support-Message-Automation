import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, ORIGINAL_PROJECT_ID, prisma as rawPrisma } from "@support-automation/db";
import { forgetProjectFeatureStates } from "@/server/projectFeatures";
import { workspaceTabs } from "@/server/workspace";
import { workspaceModule } from "@/lib/workspace";
import type { Session } from "@/server/auth";

/**
 * Which projects the Main Admin Workspace offers as tabs (MAIN_ADMIN_WORKSPACE.md §3):
 *
 *     user → may enter the project → the project has the module's feature → the existing permission
 *
 * Every refusal is a project that must NOT be a tab, so each case is set up next to one that must.
 */

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const chat = workspaceModule("whatsapp-chat")!;
const projectIds: string[] = [];
const userIds: string[] = [];
const moduleIds: string[] = [];
let slugs: { open: string; chatOff: string; archived: string; suspended: string; noAccess: string };
let reader: Session;
let mainAdmin: Session;
let noRole: Session;
let openId: string;
let chatOffId: string;

async function role(name: string, keys: string[]): Promise<string> {
  const permissions = await Promise.all(
    keys.map((key) => rawPrisma.permission.upsert({ where: { key }, create: { key, label: key, category: "Test" }, update: {}, select: { id: true } })),
  );
  const mod = await rawPrisma.permissionModule.create({
    data: { name: `${name} ${tag}`, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } },
  });
  moduleIds.push(mod.id);
  return mod.id;
}

async function user(name: string, permissionModuleId: string | null): Promise<Session> {
  const row = await rawPrisma.user.create({
    data: { username: `${name}_${tag}`, email: `${name}_${tag}@example.test`, name, passwordHash: "x", permissionModuleId },
  });
  userIds.push(row.id);
  return { userId: row.id, username: row.username, email: row.email ?? "", name };
}

async function project(label: string): Promise<{ id: string; slug: string }> {
  const created = await createProjectWithDefaults(
    { name: `WS ${label} ${tag}`, slug: `ws-${label}-${tag}`, status: "ACTIVE", creatorUserId: userIds[0]! },
    rawPrisma,
  );
  projectIds.push(created.id);
  return created;
}

beforeAll(async () => {
  // Creates the projects, so it is given access to all of them and is otherwise unused.
  await user("creator", null);
  reader = await user("reader", await role("WS reader", ["messages.view"]));
  mainAdmin = await user("mainadmin", await role("WS main admin", ["messages.view", "projects.view", "projects.manage"]));
  noRole = await user("norole", await role("WS no chat", ["rules.view"]));

  const open = await project("open");
  const chatOff = await project("chatoff");
  const archived = await project("archived");
  const suspended = await project("suspended");
  const noAccess = await project("noaccess");
  openId = open.id;
  chatOffId = chatOff.id;
  slugs = { open: open.slug, chatOff: chatOff.slug, archived: archived.slug, suspended: suspended.slug, noAccess: noAccess.slug };

  await rawPrisma.projectFeature.updateMany({ where: { projectId: chatOff.id, key: "WHATSAPP_CHAT" }, data: { enabled: false } });
  await rawPrisma.project.update({ where: { id: archived.id }, data: { status: "ARCHIVED" } });
  await rawPrisma.project.update({ where: { id: suspended.id }, data: { status: "SUSPENDED" } });
  // Everything except noAccess (and ISP Digital) for the reader; one project for the user whose role lacks chat.
  await rawPrisma.projectAccess.createMany({
    data: [open.id, chatOff.id, archived.id, suspended.id].map((projectId) => ({ projectId, userId: reader.userId })),
  });
  await rawPrisma.projectAccess.create({ data: { projectId: open.id, userId: noRole.userId } });
  forgetProjectFeatureStates();
});

afterAll(async () => {
  await rawPrisma.projectAccess.deleteMany({ where: { projectId: { in: projectIds } } });
  const tables = (
    await rawPrisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`
  ).map((row) => row.table_name);
  for (let pass = 0; pass < 4; pass++) {
    for (const table of tables) {
      await rawPrisma.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "projectId" = ANY($1)`, projectIds).catch(() => undefined);
    }
  }
  await rawPrisma.project.deleteMany({ where: { id: { in: projectIds } } });
  await rawPrisma.user.deleteMany({ where: { id: { in: userIds } } });
  await rawPrisma.permissionModule.deleteMany({ where: { id: { in: moduleIds } } });
  await rawPrisma.$disconnect();
});

async function tabSlugs(session: Session): Promise<string[]> {
  const result = await workspaceTabs(session, chat);
  if (!result.ok) throw new Error(`expected tabs, got ${result.reason}`);
  return result.tabs.map((tab) => tab.slug);
}

describe("workspace tabs", () => {
  it("a user sees exactly the projects they may enter, with the module on, that are not archived", async () => {
    const tabs = await tabSlugs(reader);
    expect(tabs).toContain(slugs.open);
    expect(tabs).toContain(slugs.suspended); // read-only, but still theirs to read
    expect(tabs).not.toContain(slugs.chatOff); // feature switched off
    expect(tabs).not.toContain(slugs.archived); // archived projects leave the switcher, and the tabs
    expect(tabs).not.toContain(slugs.noAccess); // no ProjectAccess row
    expect(tabs).not.toContain("isp-digital"); // no access to the first project either
  });

  it("the status travels with the tab, so a suspended project is shown as such", async () => {
    const result = await workspaceTabs(reader, chat);
    expect(result.ok && result.tabs.find((tab) => tab.slug === slugs.suspended)?.status).toBe("SUSPENDED");
  });

  it("a Main Admin may enter every project, and still gets no tab where the module is off", async () => {
    const tabs = await tabSlugs(mainAdmin);
    expect(tabs).toEqual(expect.arrayContaining(["isp-digital", slugs.open, slugs.suspended, slugs.noAccess]));
    expect(tabs).not.toContain(slugs.chatOff);
    expect(tabs).not.toContain(slugs.archived);
  });

  it("access to a project does not replace the permission: no role permission, no tabs at all", async () => {
    expect(await workspaceTabs(noRole, chat)).toEqual({ ok: false, reason: "NO_PERMISSION" });
  });

  it("removing access removes the tab at once — a stale tab is not kept", async () => {
    await rawPrisma.projectAccess.deleteMany({ where: { projectId: openId, userId: reader.userId } });
    expect(await tabSlugs(reader)).not.toContain(slugs.open);
    await rawPrisma.projectAccess.create({ data: { projectId: openId, userId: reader.userId } });
    expect(await tabSlugs(reader)).toContain(slugs.open);
  });

  it("switching the module on gives the project its tab", async () => {
    await rawPrisma.projectFeature.updateMany({ where: { projectId: chatOffId, key: "WHATSAPP_CHAT" }, data: { enabled: true } });
    forgetProjectFeatureStates(); // what setProjectFeature does in the portal
    expect(await tabSlugs(reader)).toContain(slugs.chatOff);
  });

  it("an inactive user has no tabs", async () => {
    await rawPrisma.user.update({ where: { id: reader.userId }, data: { isActive: false } });
    expect(await workspaceTabs(reader, chat)).toEqual({ ok: false, reason: "NO_PERMISSION" });
    await rawPrisma.user.update({ where: { id: reader.userId }, data: { isActive: true } });
  });

  it("ISP Digital itself is untouched by any of this", async () => {
    expect(await rawPrisma.project.findUnique({ where: { id: ORIGINAL_PROJECT_ID }, select: { status: true } })).toEqual({ status: "ACTIVE" });
  });
});
