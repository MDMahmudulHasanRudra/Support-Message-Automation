import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import { templateModules } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Applying a module configuration (PROJECT_MODULES.md) through the real action, scoped client and
 * permission check: hard dependencies come back, the plan holds back new additions only, a stale
 * version is refused, only changed feature rows are written, history is append-only, Restore goes
 * through the same validation, and another customer's project is not reachable.
 */

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
let current: Session;
vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  requireSession: async () => current,
  getSession: async () => current,
}));
vi.mock("next/headers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/headers")>()),
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const { runWithTenant } = await import("@/server/tenant");
const { applyProjectModules, restoreProjectModules } = await import("@/server/actions/projectModules");
const { getProjectModuleState } = await import("@/server/projectModules");

const created = { customers: [] as string[], projects: [] as string[], users: [] as string[], roles: [] as string[] };
let customerA = "";
let customerB = "";
let projectA = "";
let projectB = "";
let admin: Session;
let viewer: Session;

async function person(name: string, keys: string[], customerId: string): Promise<Session> {
  const permissions = await Promise.all(keys.map((key) => rawPrisma.permission.upsert({ where: { key }, create: { key, label: key, category: "Test" }, update: {}, select: { id: true } })));
  const role = await rawPrisma.permissionModule.create({ data: { name: `${name} ${tag}`, customerId, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } } });
  created.roles.push(role.id);
  const u = await rawPrisma.user.create({ data: { username: `${name}_${tag}`, email: `${name}_${tag}@example.test`, name, passwordHash: "x", permissionModuleId: role.id, customerId } });
  created.users.push(u.id);
  return { userId: u.id, username: u.username, email: u.email ?? "", name };
}

const inA = <T,>(fn: () => Promise<T>) => runWithTenant(customerA, fn);
const state = (id: string) => inA(() => getProjectModuleState(id));
const featureRows = (projectId: string) => rawPrisma.projectFeature.findMany({ where: { projectId }, select: { key: true, enabled: true, updatedAt: true } });

beforeAll(async () => {
  customerA = (await rawPrisma.customer.create({ data: { name: `Modules A ${tag}` } })).id;
  customerB = (await rawPrisma.customer.create({ data: { name: `Modules B ${tag}` } })).id;
  created.customers.push(customerA, customerB);
  admin = await person("modadmin", ["projects.view", "projects.manage"], customerA);
  viewer = await person("modviewer", ["projects.view"], customerA);
  projectA = (await createProjectWithDefaults({ name: `Modules A ${tag}`, slug: `mod-a-${tag}`, status: "ACTIVE", creatorUserId: null, customerId: customerA }, rawPrisma)).id;
  projectB = (await createProjectWithDefaults({ name: `Modules B ${tag}`, slug: `mod-b-${tag}`, status: "ACTIVE", creatorUserId: null, customerId: customerB }, rawPrisma)).id;
  created.projects.push(projectA, projectB);
  // A fresh project has no feature rows: its modules are the defaults, i.e. the Default template.
  await rawPrisma.projectFeature.deleteMany({ where: { projectId: { in: [projectA, projectB] } } });
});

afterAll(async () => {
  // History is append-only by trigger; lift it only to clean up this suite's rows.
  await rawPrisma.$executeRawUnsafe('ALTER TABLE "ProjectModuleConfigChange" DISABLE TRIGGER "ProjectModuleConfigChange_append_only"');
  try {
    await rawPrisma.projectModuleConfigChange.deleteMany({ where: { projectId: { in: created.projects } } });
  } finally {
    await rawPrisma.$executeRawUnsafe('ALTER TABLE "ProjectModuleConfigChange" ENABLE TRIGGER "ProjectModuleConfigChange_append_only"');
  }
  await rawPrisma.subscription.deleteMany({ where: { customerId: { in: created.customers } } });
  await rawPrisma.projectFeature.deleteMany({ where: { projectId: { in: created.projects } } });
  await rawPrisma.projectAccess.deleteMany({ where: { projectId: { in: created.projects } } });
  await rawPrisma.user.deleteMany({ where: { id: { in: created.users } } });
  await rawPrisma.permissionModule.deleteMany({ where: { id: { in: created.roles } } });
  await rawPrisma.project.updateMany({ where: { id: { in: created.projects } }, data: { status: "ARCHIVED", customerId: null } });
  await rawPrisma.customer.deleteMany({ where: { id: { in: created.customers } } });
});

describe("reading", () => {
  it("an existing project is DEFAULT at version 0 with exactly today's defaults", async () => {
    const s = await state(projectA);
    expect(s).toMatchObject({ projectType: "DEFAULT", version: 0, enabled: templateModules("DEFAULT") });
  });

  it("another customer's project is not reachable", async () => {
    expect(await state(projectB)).toBeNull();
  });
});

describe("applying", () => {
  it("refuses a viewer without projects.manage, and writes nothing", async () => {
    current = viewer;
    const r = await inA(() => applyProjectModules(projectA, { modules: ["CLIENT_CENTER"], declined: [], baseType: null, expectedVersion: 0, reason: "" }));
    expect(r.error).toMatch(/Manage Projects/);
    expect(await featureRows(projectA)).toEqual([]);
  });

  it("adds hard dependencies, writes only changed rows, records history and becomes Custom Mix", async () => {
    current = admin;
    const modules = [...templateModules("DEFAULT"), "CLIENT_SMART_IMPORT"];
    const r = await inA(() => applyProjectModules(projectA, { modules, declined: [], baseType: "DEFAULT", expectedVersion: 0, reason: "Bought Smart Import" }));
    expect(r.error).toBeUndefined();
    expect(r.version).toBe(1);
    const rows = await featureRows(projectA);
    expect(rows.map((x) => [x.key, x.enabled]).sort()).toEqual([["CLIENT_CENTER", true], ["CLIENT_SMART_IMPORT", true]]);
    const s = await state(projectA);
    expect(s).toMatchObject({ projectType: "CUSTOM_MIX", projectBaseType: "DEFAULT", version: 1 });
    expect(s!.history[0]).toMatchObject({ version: 1, autoAdded: ["CLIENT_CENTER"], reason: "Bought Smart Import", actorUsername: admin.username });
    await expect(rawPrisma.projectModuleConfigChange.updateMany({ where: { projectId: projectA }, data: { reason: "rewritten" } })).rejects.toThrow();
  });

  it("refuses a stale version: two admins cannot overwrite each other unseen", async () => {
    current = admin;
    const r = await inA(() => applyProjectModules(projectA, { modules: templateModules("DEFAULT"), declined: [], baseType: "DEFAULT", expectedVersion: 0, reason: "" }));
    expect(r.error).toMatch(/changed this project's modules/);
    expect((await state(projectA))!.version).toBe(1);
  });

  it("a removed hard dependency comes back instead of being saved", async () => {
    current = admin;
    const s = (await state(projectA))!;
    const r = await inA(() => applyProjectModules(projectA, { modules: s.enabled.filter((k) => k !== "CLIENT_CENTER"), declined: [], baseType: "DEFAULT", expectedVersion: s.version, reason: "" }));
    expect(r.success).toMatch(/Nothing to change/);
    expect((await state(projectA))!.enabled).toContain("CLIENT_CENTER");
  });

  it("refuses unknown and planned modules", async () => {
    current = admin;
    const s = (await state(projectA))!;
    const r = await inA(() => applyProjectModules(projectA, { modules: [...s.enabled, "ORDERS", "NOPE"], declined: [], baseType: null, expectedVersion: s.version, reason: "" }));
    expect(r.issues?.map((i) => i.code).sort()).toEqual(["NOT_AVAILABLE", "UNKNOWN_MODULE"]);
  });

  it("the plan holds back new additions, but never switches off what is already on", async () => {
    current = admin;
    await rawPrisma.subscription.create({
      data: { customerId: customerA, planName: "Basic", currency: "BDT", priceMinor: BigInt(100), startsAt: new Date(), paidThrough: new Date(Date.now() + 86_400_000), features: ["WHATSAPP_CHAT"], allModules: false },
    });
    const s = (await state(projectA))!;
    expect(s.entitlement.restricted).toBe(true);
    const add = await inA(() => applyProjectModules(projectA, { modules: [...s.enabled, "GOOGLE_SHEETS"], declined: [], baseType: null, expectedVersion: s.version, reason: "" }));
    expect(add.issues).toEqual([expect.objectContaining({ code: "NOT_IN_PLAN", key: "GOOGLE_SHEETS" })]);
    // Removing one module keeps every other already-on module, although the plan would not add them today.
    const remove = await inA(() => applyProjectModules(projectA, { modules: s.enabled.filter((k) => k !== "BULK_MESSAGING"), declined: [], baseType: null, expectedVersion: s.version, reason: "" }));
    expect(remove.error).toBeUndefined();
    const after = (await state(projectA))!;
    expect(after.enabled).not.toContain("BULK_MESSAGING");
    expect(after.enabled).toContain("CLIENT_CENTER");
    await rawPrisma.subscription.deleteMany({ where: { customerId: customerA } });
  });

  it("Restore re-applies an earlier configuration through the same validation", async () => {
    current = admin;
    const s = (await state(projectA))!;
    const first = s.history.find((h) => h.version === 1)!;
    const r = await inA(() => restoreProjectModules(projectA, first.id, s.version));
    expect(r.error).toBeUndefined();
    const after = (await state(projectA))!;
    expect(after.enabled).toEqual([...first.modules].sort());
    expect(after.history[0]!.reason).toBe("Restored configuration v1");
  });

  it("cannot change another customer's project", async () => {
    current = admin;
    const r = await inA(() => applyProjectModules(projectB, { modules: ["WHATSAPP_CHAT"], declined: [], baseType: null, expectedVersion: 0, reason: "" }));
    expect(r.error).toMatch(/no longer exists/);
    expect(await featureRows(projectB)).toEqual([]);
  });
});
