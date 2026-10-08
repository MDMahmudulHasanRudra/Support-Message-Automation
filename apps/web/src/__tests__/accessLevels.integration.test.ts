import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ORIGINAL_PROJECT_ID, prisma as rawPrisma } from "@support-automation/db";
import { runWithProject, type ActiveProject } from "@/server/projectContext";
import { getGrantedPermissionKeys, hasPermission, permissionRefusal } from "@/server/permissions";
import type { Session } from "@/server/auth";

/**
 * Project access levels in the web's permission checks (MAIN_ADMIN_WORKSPACE.md §4). `hasPermission`
 * is what every page, action and `checkPermission` asks, so the level must bite there — and only
 * ever narrow what the role grants.
 */

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
let session: Session;
let noRoleSession: Session;
let roleId: string;
const ROLE_KEYS = ["messages.view", "messages.reply", "automation_rules.view", "automation_rules.delete", "settings.edit", "users.create"] as const;

const isp = (accessLevel?: ActiveProject["accessLevel"]): ActiveProject => ({ id: ORIGINAL_PROJECT_ID, slug: "isp-digital", name: "ISP Digital", status: "ACTIVE", accessLevel });
const inProject = <T,>(level: ActiveProject["accessLevel"], fn: () => Promise<T>) => runWithProject(isp(level), fn);

beforeAll(async () => {
  const permissions = await Promise.all(
    ROLE_KEYS.map((key) => rawPrisma.permission.upsert({ where: { key }, create: { key, label: key, category: "Test" }, update: {}, select: { id: true } })),
  );
  roleId = (await rawPrisma.permissionModule.create({ data: { name: `Levels ${tag}`, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } } })).id;
  const user = await rawPrisma.user.create({ data: { username: `lvl_${tag}`, email: `lvl_${tag}@example.test`, name: "Lvl", passwordHash: "x", permissionModuleId: roleId } });
  const bare = await rawPrisma.user.create({ data: { username: `lvl0_${tag}`, email: `lvl0_${tag}@example.test`, name: "Lvl0", passwordHash: "x" } });
  session = { userId: user.id, username: user.username, email: user.email ?? "", name: user.name };
  noRoleSession = { userId: bare.id, username: bare.username, email: bare.email ?? "", name: bare.name };
});

afterAll(async () => {
  await rawPrisma.user.deleteMany({ where: { username: { in: [`lvl_${tag}`, `lvl0_${tag}`] } } });
  await rawPrisma.permissionModule.deleteMany({ where: { id: roleId } });
  await rawPrisma.$disconnect();
});

describe("access levels in the permission checks", () => {
  it("READ: the role's read keys, nothing that changes the project", async () => {
    await inProject("READ", async () => {
      expect(await hasPermission(session, "messages.view")).toBe(true);
      expect(await hasPermission(session, "automation_rules.view")).toBe(true);
      expect(await hasPermission(session, "messages.reply")).toBe(false);
      expect(await hasPermission(session, "automation_rules.delete")).toBe(false);
      expect(await hasPermission(session, "settings.edit")).toBe(false);
      expect(await permissionRefusal(session, "messages.reply")).toBe("LEVEL");
    });
  });

  it("WRITE: day-to-day work, but no deleting and no project settings", async () => {
    await inProject("WRITE", async () => {
      expect(await hasPermission(session, "messages.reply")).toBe(true);
      expect(await hasPermission(session, "automation_rules.delete")).toBe(false);
      expect(await hasPermission(session, "settings.edit")).toBe(false);
    });
  });

  it("FULL, and no level at all, is exactly the role", async () => {
    for (const level of ["FULL", undefined] as const) {
      await inProject(level, async () => {
        for (const key of ROLE_KEYS) expect(await hasPermission(session, key), `${level} ${key}`).toBe(true);
      });
    }
  });

  it("a level never grants what the role lacks — FULL is not a bypass", async () => {
    await inProject("FULL", async () => {
      expect(await hasPermission(session, "whatsapp.manage")).toBe(false);
      expect(await permissionRefusal(session, "whatsapp.manage")).toBe("ROLE");
      expect(await hasPermission(noRoleSession, "messages.view")).toBe(false);
    });
  });

  it("keys whose data is no project's are not narrowed by a project's level", async () => {
    await inProject("READ", async () => {
      expect(await hasPermission(session, "users.create")).toBe(true);
    });
  });

  it("outside a project (the Main Admin Portal) only the role decides", async () => {
    expect(await hasPermission(session, "messages.reply")).toBe(true);
    expect(await hasPermission(session, "settings.edit")).toBe(true);
  });

  it("what the shell offers follows the level too", async () => {
    const read = await inProject("READ", () => getGrantedPermissionKeys(session));
    expect(read.sort()).toEqual(["automation_rules.view", "messages.view", "users.create"]);
    const write = await inProject("WRITE", () => getGrantedPermissionKeys(session));
    expect(write.sort()).toEqual(["automation_rules.view", "messages.reply", "messages.view", "users.create"]);
    expect((await getGrantedPermissionKeys(session)).sort()).toEqual([...ROLE_KEYS].sort());
  });
});
