import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, ORIGINAL_PROJECT_ID, prisma as rawPrisma } from "@support-automation/db";
import { forgetProjectFeatureStates } from "@/server/projectFeatures";
import { chooseWorkspaceProject, workspaceProjects } from "@/server/workspace";
import { workspaceTabsFor } from "@/lib/workspace";
import type { Session } from "@/server/auth";

/**
 * The Main Admin Workspace's server half (MAIN_ADMIN_WORKSPACE.md §3): which projects the tabs can
 * ever show, and which one a module opens in —
 *
 *     user → may enter the project → the page's feature is on there → the existing permission
 *
 * Every refusal is a project that must NOT be offered, so each case sits next to one that must.
 * Three projects stand in for ISP Digital / Edufy / Biznify: one with every feature, one with
 * Reports and Bulk Messaging off, one with WhatsApp Chat off.
 */

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const projectIds: string[] = [];
const userIds: string[] = [];
const moduleIds: string[] = [];
let slugs: { full: string; noReports: string; noChat: string; archived: string; suspended: string; noAccess: string };
let reader: Session;
let mainAdmin: Session;
let noChatRole: Session;
let fullId: string;
let noChatId: string;

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

async function switchOff(projectId: string, key: string) {
  await rawPrisma.projectFeature.updateMany({ where: { projectId, key }, data: { enabled: false } });
}

beforeAll(async () => {
  await user("creator", null); // creates the projects, so it has access to all of them; otherwise unused
  const everything = ["messages.view", "support_activity.view", "bulk_messaging.view", "automation_rules.view", "whatsapp.view", "users.view"];
  reader = await user("reader", await role("WS reader", everything));
  mainAdmin = await user("mainadmin", await role("WS main admin", [...everything, "projects.view", "projects.manage"]));
  noChatRole = await user("norole", await role("WS no chat", ["automation_rules.view"]));

  const full = await project("full");
  const noReports = await project("noreports");
  const noChat = await project("nochat");
  const archived = await project("archived");
  const suspended = await project("suspended");
  const noAccess = await project("noaccess");
  fullId = full.id;
  noChatId = noChat.id;
  slugs = { full: full.slug, noReports: noReports.slug, noChat: noChat.slug, archived: archived.slug, suspended: suspended.slug, noAccess: noAccess.slug };

  await switchOff(noReports.id, "TEAM_REPORTS");
  await switchOff(noReports.id, "BULK_MESSAGING");
  await switchOff(noChat.id, "WHATSAPP_CHAT");
  await rawPrisma.project.update({ where: { id: archived.id }, data: { status: "ARCHIVED" } });
  await rawPrisma.project.update({ where: { id: suspended.id }, data: { status: "SUSPENDED" } });
  await rawPrisma.projectAccess.createMany({
    data: [full.id, noReports.id, noChat.id, archived.id, suspended.id].map((projectId) => ({ projectId, userId: reader.userId })),
  });
  await rawPrisma.projectAccess.createMany({ data: [full.id, noChat.id].map((projectId) => ({ projectId, userId: noChatRole.userId })) });
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

const ours = (projects: Array<{ slug: string }>) => projects.map((p) => p.slug).filter((s) => s.endsWith(tag) || s === "isp-digital");

describe("the workspace's projects", () => {
  it("are exactly the projects the user may enter, never an archived one", async () => {
    const mine = ours(await workspaceProjects(reader));
    expect(mine.sort()).toEqual([slugs.full, slugs.noChat, slugs.noReports, slugs.suspended].sort());
    expect(mine).not.toContain(slugs.noAccess);
    expect(mine).not.toContain(slugs.archived);
    expect(mine).not.toContain("isp-digital");
  });

  it("carry each project's own switched-off features, so every module's tabs come out right", async () => {
    const projects = await workspaceProjects(reader);
    expect(ours(workspaceTabsFor(projects, "/chat")).sort()).toEqual([slugs.full, slugs.noReports, slugs.suspended].sort());
    expect(ours(workspaceTabsFor(projects, "/team-report")).sort()).toEqual([slugs.full, slugs.noChat, slugs.suspended].sort());
    expect(ours(workspaceTabsFor(projects, "/group-message-sender/history")).sort()).toEqual([slugs.full, slugs.noChat, slugs.suspended].sort());
    expect(ours(workspaceTabsFor(projects, "/rules")).sort()).toEqual([slugs.full, slugs.noChat, slugs.noReports, slugs.suspended].sort());
    expect(workspaceTabsFor(projects, "/users")).toEqual([]);
    expect(projects.find((p) => p.slug === slugs.suspended)?.status).toBe("SUSPENDED");
  });

  it("a Main Admin may enter every project — and still gets no tab where the module is off", async () => {
    const projects = await workspaceProjects(mainAdmin);
    const all = ours(projects);
    expect(all).toEqual(expect.arrayContaining(["isp-digital", slugs.full, slugs.noAccess, slugs.noChat]));
    expect(all).not.toContain(slugs.archived);
    expect(ours(workspaceTabsFor(projects, "/chat"))).not.toContain(slugs.noChat);
  });

  it("removing access removes the project at once — no stale tab", async () => {
    await rawPrisma.projectAccess.deleteMany({ where: { projectId: fullId, userId: reader.userId } });
    expect(ours(await workspaceProjects(reader))).not.toContain(slugs.full);
    await rawPrisma.projectAccess.create({ data: { projectId: fullId, userId: reader.userId } });
    expect(ours(await workspaceProjects(reader))).toContain(slugs.full);
  });

  it("switching a module on gives the project its tab", async () => {
    await rawPrisma.projectFeature.updateMany({ where: { projectId: noChatId, key: "WHATSAPP_CHAT" }, data: { enabled: true } });
    forgetProjectFeatureStates(); // what setProjectFeature does in the portal
    expect(ours(workspaceTabsFor(await workspaceProjects(reader), "/chat"))).toContain(slugs.noChat);
    await switchOff(noChatId, "WHATSAPP_CHAT");
    forgetProjectFeatureStates();
  });

  it("ISP Digital itself is untouched", async () => {
    expect(await rawPrisma.project.findUnique({ where: { id: ORIGINAL_PROJECT_ID }, select: { status: true } })).toEqual({ status: "ACTIVE" });
  });
});

describe("opening a module from the Main Admin sidebar", () => {
  it("opens in a project the viewer may enter that has the module on", async () => {
    const chat = await chooseWorkspaceProject(reader, "/chat");
    expect([slugs.full, slugs.noReports, slugs.suspended]).toContain(chat?.slug);
    const reports = await chooseWorkspaceProject(reader, "/team-report");
    expect([slugs.full, slugs.noChat, slugs.suspended]).toContain(reports?.slug);
  });

  it("the existing permission still decides: without it the module opens nowhere", async () => {
    expect(await chooseWorkspaceProject(noChatRole, "/chat")).toBeNull();
    expect(await chooseWorkspaceProject(noChatRole, "/team-report")).toBeNull();
    // …while a module the role does include opens in one of ITS projects.
    expect([slugs.full, slugs.noChat]).toContain((await chooseWorkspaceProject(noChatRole, "/rules"))?.slug);
  });

  it("a module switched off everywhere the viewer can go opens nowhere", async () => {
    const onlyNoChat = await user("onlynochat", await role("WS only no chat", ["messages.view"]));
    await rawPrisma.projectAccess.create({ data: { projectId: noChatId, userId: onlyNoChat.userId } });
    expect(await chooseWorkspaceProject(onlyNoChat, "/chat")).toBeNull();
    expect((await chooseWorkspaceProject(onlyNoChat, "/messages"))?.slug).toBe(slugs.noChat);
  });

  it("an inactive user can open nothing", async () => {
    await rawPrisma.user.update({ where: { id: reader.userId }, data: { isActive: false } });
    expect(await chooseWorkspaceProject(reader, "/chat")).toBeNull();
    await rawPrisma.user.update({ where: { id: reader.userId }, data: { isActive: true } });
  });
});
