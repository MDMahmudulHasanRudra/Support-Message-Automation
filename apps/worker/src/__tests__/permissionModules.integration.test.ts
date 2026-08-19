import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@support-automation/db";

/**
 * Hand-mirrors apps/web/src/server/actions/permissionModules.ts's Prisma writes/reads (same
 * "apps/web has no test runner" limitation documented in userSessions.integration.test.ts).
 * Focuses on the one guarantee that matters most here: a PermissionModule still assigned to a
 * user cannot be deleted — enforced by the schema's onDelete: Restrict on
 * User.permissionModuleId, not just an app-layer pre-check that could be bypassed.
 */

const createdUserIds: string[] = [];
const createdModuleIds: string[] = [];
const createdPermissionIds: string[] = [];

async function createTestPermission(key = `test.${randomUUID()}`) {
  const permission = await prisma.permission.create({ data: { key, label: key, category: "Test" } });
  createdPermissionIds.push(permission.id);
  return permission;
}

async function createTestModule(name = `Test Module ${randomUUID()}`) {
  const permissionModule = await prisma.permissionModule.create({ data: { name } });
  createdModuleIds.push(permissionModule.id);
  return permissionModule;
}

async function createTestUser(permissionModuleId?: string) {
  const user = await prisma.user.create({
    data: {
      username: `perm-test-${randomUUID()}`,
      name: "Permission Test User",
      passwordHash: "unused:unused",
      permissionModuleId,
    },
  });
  createdUserIds.push(user.id);
  return user;
}

afterEach(async () => {
  if (createdUserIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds.length = 0;
  }
  if (createdModuleIds.length) {
    await prisma.permissionModule.deleteMany({ where: { id: { in: createdModuleIds } } }); // cascades PermissionModulePermission
    createdModuleIds.length = 0;
  }
  if (createdPermissionIds.length) {
    await prisma.permission.deleteMany({ where: { id: { in: createdPermissionIds } } });
    createdPermissionIds.length = 0;
  }
});

describe("PermissionModule delete guard (onDelete: Restrict)", () => {
  it("deleting a module still assigned to a user throws a Prisma FK-violation error, not a silent success", async () => {
    const permissionModule = await createTestModule();
    await createTestUser(permissionModule.id);

    await expect(prisma.permissionModule.delete({ where: { id: permissionModule.id } })).rejects.toMatchObject({
      code: "P2003",
    });

    const stillExists = await prisma.permissionModule.findUnique({ where: { id: permissionModule.id } });
    expect(stillExists).not.toBeNull();
  });

  it("deleting a module succeeds once no user is assigned to it", async () => {
    const permissionModule = await createTestModule();
    const user = await createTestUser(permissionModule.id);

    await prisma.user.update({ where: { id: user.id }, data: { permissionModuleId: null } });
    await prisma.permissionModule.delete({ where: { id: permissionModule.id } });
    createdModuleIds.length = 0; // already deleted

    const gone = await prisma.permissionModule.findUnique({ where: { id: permissionModule.id } });
    expect(gone).toBeNull();
  });

  it("the app-layer pre-check (mirrors deletePermissionModule()) reports the exact assigned-user count", async () => {
    const permissionModule = await createTestModule();
    await createTestUser(permissionModule.id);
    await createTestUser(permissionModule.id);

    const withCount = await prisma.permissionModule.findUniqueOrThrow({
      where: { id: permissionModule.id },
      include: { _count: { select: { users: true } } },
    });

    expect(withCount._count.users).toBe(2);
  });
});

describe("PermissionModulePermission join table", () => {
  it("assigning and re-syncing permissions on a module replaces the exact set (mirrors updatePermissionModule())", async () => {
    const permissionModule = await createTestModule();
    const permA = await createTestPermission();
    const permB = await createTestPermission();
    const permC = await createTestPermission();

    await prisma.permissionModulePermission.createMany({
      data: [
        { permissionModuleId: permissionModule.id, permissionId: permA.id },
        { permissionModuleId: permissionModule.id, permissionId: permB.id },
      ],
    });

    // Re-sync to {B, C} — mirrors the update action's delete-then-recreate approach.
    await prisma.$transaction([
      prisma.permissionModulePermission.deleteMany({ where: { permissionModuleId: permissionModule.id } }),
      prisma.permissionModulePermission.createMany({
        data: [
          { permissionModuleId: permissionModule.id, permissionId: permB.id },
          { permissionModuleId: permissionModule.id, permissionId: permC.id },
        ],
      }),
    ]);

    const rows = await prisma.permissionModulePermission.findMany({
      where: { permissionModuleId: permissionModule.id },
      select: { permissionId: true },
    });
    const keys = new Set(rows.map((r) => r.permissionId));
    expect(keys.has(permA.id)).toBe(false);
    expect(keys.has(permB.id)).toBe(true);
    expect(keys.has(permC.id)).toBe(true);
    expect(rows).toHaveLength(2);
  });

  it("deleting a Permission cascades to remove its join rows, without touching the module or other permissions", async () => {
    const permissionModule = await createTestModule();
    const permA = await createTestPermission();
    const permB = await createTestPermission();
    await prisma.permissionModulePermission.createMany({
      data: [
        { permissionModuleId: permissionModule.id, permissionId: permA.id },
        { permissionModuleId: permissionModule.id, permissionId: permB.id },
      ],
    });

    await prisma.permission.delete({ where: { id: permA.id } });
    createdPermissionIds.splice(createdPermissionIds.indexOf(permA.id), 1);

    const remaining = await prisma.permissionModulePermission.findMany({ where: { permissionModuleId: permissionModule.id } });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.permissionId).toBe(permB.id);

    const moduleStillExists = await prisma.permissionModule.findUnique({ where: { id: permissionModule.id } });
    expect(moduleStillExists).not.toBeNull();
  });
});

describe("Permission catalogue upsert (mirrors seed.ts sync)", () => {
  it("upserting an existing key by value updates label/category without creating a duplicate row", async () => {
    const key = `sync.${randomUUID()}`;
    await createTestPermission(key);

    await prisma.permission.upsert({
      where: { key },
      update: { label: "Updated Label", category: "Updated Category" },
      create: { key, label: "Updated Label", category: "Updated Category" },
    });

    const rows = await prisma.permission.findMany({ where: { key } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).toBe("Updated Label");
  });
});
