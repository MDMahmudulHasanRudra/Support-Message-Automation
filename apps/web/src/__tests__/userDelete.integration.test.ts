import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { ORIGINAL_PROJECT_ID, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Deleting an App User (users.ts `deleteUser`): only a Main Admin deletes; an Administrator-level
 * account (Main Admin or project-administration keys) is never deleted, nor the actor themselves;
 * every lower user can be. What they did stays (rows keep, the name link clears), the System Log
 * says who was deleted, and Google Sheets work history blocks the delete.
 */

let current: Session;
vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  requireSession: async () => current,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/projectPaths", () => ({ projectPath: async (p: string) => `/p/isp-digital${p}`, inWorkspace: async () => false }));

const { runWithProject } = await import("@/server/projectContext");
const users = await import("@/server/actions/users");

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const inIsp = <T,>(fn: () => Promise<T>) => runWithProject({ id: ORIGINAL_PROJECT_ID, slug: "isp-digital", name: "ISP Digital", status: "ACTIVE" }, fn);
const roleIds: string[] = [];

async function role(name: string, keys: string[]) {
  const permissions = await Promise.all(
    keys.map((key) => {
      const def = PERMISSIONS.find((p) => p.key === key)!;
      return rawPrisma.permission.upsert({ where: { key }, create: { key, label: def.label, category: def.category }, update: {}, select: { id: true } });
    }),
  );
  const id = (await rawPrisma.permissionModule.create({ data: { name: `${name} ${tag}`, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } } })).id;
  roleIds.push(id);
  return id;
}
const person = (name: string, roleId: string | null) =>
  rawPrisma.user.create({ data: { username: `${name}_${tag}`, email: `${name}_${tag}@example.test`, name, passwordHash: "x", permissionModuleId: roleId } });
const sessionOf = (u: { id: string; username: string; email: string | null; name: string }) => ({ userId: u.id, username: u.username, email: u.email!, name: u.name }) as Session;
const del = (actor: Session, id: string, typed: string) => {
  current = actor;
  return inIsp(() => users.deleteUser(id, typed));
};

let mainAdmin: Awaited<ReturnType<typeof person>>;
let otherMainAdmin: Awaited<ReturnType<typeof person>>;
let projectAdmin: Awaited<ReturnType<typeof person>>;
let manager: Awaited<ReturnType<typeof person>>;
const spreadsheets: string[] = [];

beforeAll(async () => {
  const mainRole = await role("Main", ["projects.view", "projects.manage", "users.view", "users.disable"]);
  const projectAdminRole = await role("ProjAdmin", ["users.view", "project_members.manage"]);
  const managerRole = await role("Manager", ["users.view", "users.edit", "users.disable", "users.create"]);
  mainAdmin = await person("main", mainRole);
  otherMainAdmin = await person("main2", mainRole);
  projectAdmin = await person("projadmin", projectAdminRole);
  manager = await person("manager", managerRole);
});

afterAll(async () => {
  await rawPrisma.googleSheetWorkSession.deleteMany({ where: { spreadsheetId: { in: spreadsheets } } });
  await rawPrisma.googleSpreadsheet.deleteMany({ where: { id: { in: spreadsheets } } });
  await rawPrisma.client.deleteMany({ where: { code: { startsWith: `DEL-${tag}` } } });
  await rawPrisma.systemLog.deleteMany({ where: { message: "USER_DELETED", metadata: { path: ["username"], string_ends_with: tag } } });
  await rawPrisma.user.deleteMany({ where: { username: { endsWith: tag } } });
  await rawPrisma.permissionModule.deleteMany({ where: { id: { in: roleIds } } });
});

describe("who may delete whom", () => {
  it("refuses anyone who is not a Main Admin, even with every user key", async () => {
    const victim = await person("victim1", null);
    expect((await del(sessionOf(manager), victim.id, victim.username)).error).toMatch(/Only a Main Admin/);
    expect(await rawPrisma.user.findUnique({ where: { id: victim.id } })).not.toBeNull();
  });

  it("never deletes an Administrator-level account or the Main Admin's own", async () => {
    expect((await del(sessionOf(mainAdmin), otherMainAdmin.id, otherMainAdmin.username)).error).toMatch(/can never be deleted/);
    expect((await del(sessionOf(mainAdmin), projectAdmin.id, projectAdmin.username)).error).toMatch(/can never be deleted/);
    expect((await del(sessionOf(mainAdmin), mainAdmin.id, mainAdmin.username)).error).toMatch(/your own account/);
    expect(await rawPrisma.user.count({ where: { id: { in: [otherMainAdmin.id, projectAdmin.id, mainAdmin.id] } } })).toBe(3);
  });

  it("needs the username typed exactly", async () => {
    const victim = await person("victim2", null);
    expect((await del(sessionOf(mainAdmin), victim.id, "victim2")).error).toMatch(/Type the username/);
    expect(await rawPrisma.user.findUnique({ where: { id: victim.id } })).not.toBeNull();
  });
});

describe("deleting a lower user", () => {
  it("removes the login and its sessions, keeps what they did, and logs who was deleted", async () => {
    const victim = await person("victim3", (await rawPrisma.user.findUniqueOrThrow({ where: { id: manager.id } })).permissionModuleId);
    await rawPrisma.userSession.create({ data: { userId: victim.id, secretHash: `t-${tag}`, expiresAt: new Date(Date.now() + 3_600_000) } });
    const client = await rawPrisma.client.create({ data: { projectId: ORIGINAL_PROJECT_ID, code: `DEL-${tag}`, name: "Kept Client", createdById: victim.id } });
    expect((await del(sessionOf(mainAdmin), victim.id, victim.username)).ok).toBe(true);
    expect(await rawPrisma.user.findUnique({ where: { id: victim.id } })).toBeNull();
    expect(await rawPrisma.userSession.count({ where: { userId: victim.id } })).toBe(0);
    expect(await rawPrisma.client.findUniqueOrThrow({ where: { id: client.id } })).toMatchObject({ name: "Kept Client", createdById: null });
    const log = await rawPrisma.systemLog.findFirst({ where: { message: "USER_DELETED", metadata: { path: ["deletedUserId"], equals: victim.id } } });
    expect(log?.metadata).toMatchObject({ username: victim.username, actorId: mainAdmin.id });
  });

  it("refuses, with a reason, a user whose Google Sheets work history must be kept", async () => {
    const victim = await person("victim4", null);
    const sheet = await rawPrisma.googleSpreadsheet.create({ data: { projectId: ORIGINAL_PROJECT_ID, googleFileId: `f-${tag}`, name: "Hours" } });
    spreadsheets.push(sheet.id);
    await rawPrisma.googleSheetWorkSession.create({ data: { projectId: ORIGINAL_PROJECT_ID, spreadsheetId: sheet.id, userId: victim.id, clientKey: `k-${tag}`, startedAt: new Date(), lastSignalAt: new Date() } });
    expect((await del(sessionOf(mainAdmin), victim.id, victim.username)).error).toMatch(/Google Sheets work history/);
    expect(await rawPrisma.user.findUnique({ where: { id: victim.id } })).not.toBeNull();
  });
});
