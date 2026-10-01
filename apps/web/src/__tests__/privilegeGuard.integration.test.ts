import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { ORIGINAL_PROJECT_ID, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Audit HIGH #1: nobody becomes a Main Admin, or takes over one, except by a Main Admin's hand
 * (server/privilegeGuard.ts). The actions are called exactly as a browser would call them — they are
 * public endpoints — with only the request plumbing (session cookie, redirect, cache) stubbed.
 *
 * "Escalator" holds every user- and role-editing key and the read-only portal key, but not
 * `projects.manage`: before the guard each of the eight attempts below succeeded.
 */

let current: Session;
vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  requireSession: async () => current,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { to });
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/server/projectPaths", () => ({ projectPath: async (p: string) => `/p/isp-digital${p}`, inWorkspace: async () => false }));

const { runWithProject } = await import("@/server/projectContext");
const users = await import("@/server/actions/users");
const roles = await import("@/server/actions/permissionModules");
const admin = await import("@/server/actions/adminUsers");
const { MAIN_ADMIN_ONLY_ERROR } = await import("@/server/privilegeGuard");

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const ids = { escalatorRole: "", mainRole: "", plainRole: "", escalator: "", mainAdmin: "", victim: "", regular: "" };
const sessions: Record<"escalator" | "mainAdmin", Session> = {} as never;

const inIsp = <T,>(fn: () => Promise<T>) =>
  runWithProject({ id: ORIGINAL_PROJECT_ID, slug: "isp-digital", name: "ISP Digital", status: "ACTIVE" }, fn);
/** An action's result; a redirect (the success path of a form action) reads as `{ redirected }`. */
async function call<T>(fn: () => Promise<T>): Promise<T | { redirected: string }> {
  try {
    return await inIsp(fn);
  } catch (err) {
    if ((err as Error).message === "NEXT_REDIRECT") return { redirected: (err as { to: string }).to };
    throw err;
  }
}
const form = (entries: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) for (const value of [v].flat()) f.append(k, value);
  return f;
};

/** The real catalogue rows (the seed's), created if this throwaway database was never seeded. */
const permissionRows = (keys: string[]) =>
  Promise.all(
    keys.map((key) => {
      const def = PERMISSIONS.find((p) => p.key === key)!;
      return rawPrisma.permission.upsert({ where: { key }, create: { key, label: def.label, category: def.category }, update: {}, select: { id: true } });
    }),
  );

async function role(name: string, keys: string[]) {
  const permissions = await permissionRows(keys);
  return (await rawPrisma.permissionModule.create({ data: { name, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } } })).id;
}
async function person(name: string, roleId: string | null) {
  const u = await rawPrisma.user.create({
    data: { username: `${name}_${tag}`, email: `${name}_${tag}@example.test`, name, passwordHash: `original-${name}`, permissionModuleId: roleId },
  });
  return u;
}
const state = (id: string) => rawPrisma.user.findUniqueOrThrow({ where: { id }, select: { permissionModuleId: true, passwordHash: true, isActive: true } });

beforeAll(async () => {
  ids.escalatorRole = await role(`Escalator ${tag}`, [
    "users.view",
    "users.create",
    "users.edit",
    "users.disable",
    "permissions.view",
    "permissions.create",
    "permissions.edit",
    "projects.view",
  ]);
  ids.mainRole = await role(`MainAdmin ${tag}`, ["projects.view", "projects.manage", "users.edit", "users.create", "users.disable"]);
  ids.plainRole = await role(`Plain ${tag}`, ["messages.view"]);
  const e = await person("escalator", ids.escalatorRole);
  const m = await person("mainadmin", ids.mainRole);
  ids.escalator = e.id;
  ids.mainAdmin = m.id;
  ids.victim = (await person("victim", ids.mainRole)).id;
  ids.regular = (await person("regular", ids.plainRole)).id;
  sessions.escalator = { userId: e.id, username: e.username, email: e.email!, name: e.name } as Session;
  sessions.mainAdmin = { userId: m.id, username: m.username, email: m.email!, name: m.name } as Session;
});

beforeEach(() => {
  current = sessions.escalator;
});

afterAll(async () => {
  await rawPrisma.userSession.deleteMany({ where: { user: { username: { endsWith: tag } } } });
  await rawPrisma.user.deleteMany({ where: { username: { endsWith: tag } } });
  await rawPrisma.permissionModule.deleteMany({ where: { name: { endsWith: tag } } });
  await rawPrisma.$disconnect();
});

describe("a role without projects.manage cannot reach Main Admin", () => {
  it("cannot put itself on a Main Admin role (App Users → edit)", async () => {
    const r = await call(() => users.updateUser(ids.escalator, {}, form({ name: "escalator", permissionModuleId: ids.mainRole })));
    expect(r).toEqual({ error: MAIN_ADMIN_ONLY_ERROR });
    expect((await state(ids.escalator)).permissionModuleId).toBe(ids.escalatorRole);
  });

  it("cannot create a login on a Main Admin role (App Users → new)", async () => {
    const r = await call(() =>
      users.createUser({}, form({ username: `sneaky_${tag}`, name: "Sneaky", password: "correct horse battery", confirmPassword: "correct horse battery", permissionModuleId: ids.mainRole })),
    );
    expect(r).toEqual({ error: MAIN_ADMIN_ONLY_ERROR });
    expect(await rawPrisma.user.findUnique({ where: { username: `sneaky_${tag}` } })).toBeNull();
  });

  it("cannot create one from the Main Admin portal either", async () => {
    const r = await call(() =>
      admin.createUserFromAdmin({}, form({ username: `sneaky2_${tag}`, name: "Sneaky", password: "correct horse battery", confirmPassword: "correct horse battery", permissionModuleId: ids.mainRole })),
    );
    expect(r).toEqual({ error: MAIN_ADMIN_ONLY_ERROR });
    expect(await rawPrisma.user.findUnique({ where: { username: `sneaky2_${tag}` } })).toBeNull();
  });

  it("cannot move somebody onto a Main Admin role (Users & Permissions → role)", async () => {
    expect(await call(() => admin.setUserRole(ids.regular, ids.mainRole))).toEqual({ error: MAIN_ADMIN_ONLY_ERROR });
    expect((await state(ids.regular)).permissionModuleId).toBe(ids.plainRole);
  });

  it("cannot add a Main Admin key to a role, or create a role holding one", async () => {
    const before = await rawPrisma.permissionModulePermission.count({ where: { permissionModuleId: ids.plainRole } });
    const r = await call(() => roles.updatePermissionModule(ids.plainRole, {}, form({ name: `Plain ${tag}`, permissionKeys: ["messages.view", "projects.manage"] })));
    expect(r).toEqual({ error: MAIN_ADMIN_ONLY_ERROR });
    expect(await rawPrisma.permissionModulePermission.count({ where: { permissionModuleId: ids.plainRole } })).toBe(before);
    const c = await call(() => roles.createPermissionModule({}, form({ name: `New ${tag}`, permissionKeys: ["projects.manage"] })));
    expect(c).toEqual({ error: MAIN_ADMIN_ONLY_ERROR });
    expect(await rawPrisma.permissionModule.findUnique({ where: { name: `New ${tag}` } })).toBeNull();
  });

  it("cannot take over a Main Admin: password, role, or deactivation", async () => {
    const before = await state(ids.victim);
    expect(await call(() => users.resetUserPassword(ids.victim, "attacker chosen password"))).toEqual({ error: MAIN_ADMIN_ONLY_ERROR });
    expect(await call(() => users.setUserActive(ids.victim, false))).toEqual({ error: MAIN_ADMIN_ONLY_ERROR });
    expect(await call(() => admin.setUserRole(ids.victim, ids.plainRole))).toEqual({ error: MAIN_ADMIN_ONLY_ERROR });
    expect(await state(ids.victim)).toEqual(before);
  });
});

describe("everything else still works exactly as before", () => {
  it("the same role still manages ordinary users and roles", async () => {
    expect(await call(() => users.resetUserPassword(ids.regular, "a brand new password"))).toEqual({});
    expect((await state(ids.regular)).passwordHash).not.toBe("original-regular");
    expect(await call(() => users.setUserActive(ids.regular, false))).toEqual({});
    expect(await call(() => users.setUserActive(ids.regular, true))).toEqual({});
    expect(await call(() => admin.setUserRole(ids.regular, ids.plainRole))).toEqual({ success: expect.stringContaining("Role set") });
    expect(await call(() => roles.createPermissionModule({}, form({ name: `Ordinary ${tag}`, permissionKeys: ["messages.view"] })))).toEqual({
      redirected: "/p/isp-digital/permissions",
    });
    // Editing a user's name without touching their role is not a privileged change.
    expect(await call(() => users.updateUser(ids.victim, {}, form({ name: "victim renamed", permissionModuleId: ids.mainRole })))).toEqual({
      redirected: "/p/isp-digital/users",
    });
  });

  it("a Main Admin may do every one of the refused changes", async () => {
    current = sessions.mainAdmin;
    expect(await call(() => users.resetUserPassword(ids.victim, "main admin chose this"))).toEqual({});
    expect(await call(() => admin.setUserRole(ids.regular, ids.mainRole))).toEqual({ success: expect.stringContaining("Role set") });
    expect((await state(ids.regular)).permissionModuleId).toBe(ids.mainRole);
  });
});
