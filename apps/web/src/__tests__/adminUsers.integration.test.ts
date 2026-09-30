import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, ORIGINAL_PROJECT_ID, prisma as rawPrisma } from "@support-automation/db";
import { createUserWithAccess, listAdminUsers, setUserProjectAccess, userAccessMatrix } from "@/server/adminUsers";
import { createDepartment, setDepartmentActive } from "@/server/configuration";
import { verifyPassword } from "@/server/auth";

/**
 * Main Admin → Users & Permissions (MAIN_ADMIN_WORKSPACE.md §5): the login, the person, the role and
 * the project access created together, in one transaction, and project access edited per project
 * with a level.
 */

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const created = { users: [] as string[], projects: [] as string[], departments: [] as string[] };
let bizId: string;
let archivedId: string;
let roleId: string;

const base = (name: string) => ({
  username: `${name}_${tag}`,
  name: `${name} ${tag}`,
  password: "correct horse battery",
  confirmPassword: "correct horse battery",
  access: [] as Array<{ projectId: string; level: "READ" | "WRITE" | "FULL" }>,
});

async function track<T extends { ok: boolean; userId?: string }>(p: Promise<T>): Promise<T> {
  const r = await p;
  if (r.ok && r.userId) created.users.push(r.userId);
  return r;
}

beforeAll(async () => {
  const creator = await rawPrisma.user.create({ data: { username: `au_creator_${tag}`, email: `au_c_${tag}@example.test`, name: "C", passwordHash: "x" } });
  created.users.push(creator.id);
  bizId = (await createProjectWithDefaults({ name: `AU Biz ${tag}`, slug: `au-biz-${tag}`, status: "ACTIVE", creatorUserId: creator.id }, rawPrisma)).id;
  archivedId = (await createProjectWithDefaults({ name: `AU Arch ${tag}`, slug: `au-arch-${tag}`, status: "ACTIVE", creatorUserId: creator.id }, rawPrisma)).id;
  created.projects.push(bizId, archivedId);
  await rawPrisma.project.update({ where: { id: archivedId }, data: { status: "ARCHIVED" } });
  roleId = (await rawPrisma.permissionModule.create({ data: { name: `AU role ${tag}` } })).id;
});

afterAll(async () => {
  await rawPrisma.employee.deleteMany({ where: { OR: [{ userId: { in: created.users } }, { fullName: { contains: tag } }] } });
  await rawPrisma.projectAccess.deleteMany({ where: { OR: [{ userId: { in: created.users } }, { projectId: { in: created.projects } }] } });
  const tables = (
    await rawPrisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`
  ).map((row) => row.table_name);
  for (let pass = 0; pass < 4; pass++) {
    for (const table of tables) await rawPrisma.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "projectId" = ANY($1)`, created.projects).catch(() => undefined);
  }
  await rawPrisma.project.deleteMany({ where: { id: { in: created.projects } } });
  await rawPrisma.user.deleteMany({ where: { OR: [{ id: { in: created.users } }, { username: { contains: tag } }] } });
  await rawPrisma.permissionModule.deleteMany({ where: { id: roleId } });
  await rawPrisma.department.deleteMany({ where: { id: { in: created.departments } } });
  await rawPrisma.$disconnect();
});

describe("creating a user from the Main Admin Portal", () => {
  it("creates the login, a new employee, the role and the project access together", async () => {
    const r = await track(
      createUserWithAccess(rawPrisma, {
        ...base("full"),
        permissionModuleId: roleId,
        employee: { create: { fullName: `Full Person ${tag}` } },
        access: [
          { projectId: ORIGINAL_PROJECT_ID, level: "READ" },
          { projectId: bizId, level: "FULL" },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const user = await rawPrisma.user.findUniqueOrThrow({
      where: { id: r.userId },
      include: { employee: true, projectAccess: { orderBy: { projectId: "asc" } } },
    });
    expect(user.permissionModuleId).toBe(roleId);
    expect(verifyPassword("correct horse battery", user.passwordHash)).toBe(true);
    expect(user.employee?.employeeCode).toMatch(/^EMP-\d{6}$/);
    expect(user.employee?.employeeCode).toBe(r.employeeCode);
    const levels = Object.fromEntries(user.projectAccess.map((a) => [a.projectId, a.level]));
    // FULL is stored as null — what "no narrowing" has always meant on this table.
    expect(levels).toEqual({ [ORIGINAL_PROJECT_ID]: "READ", [bizId]: null });
  });

  it("links an existing employee instead, and refuses one who already has a login", async () => {
    const emp = await rawPrisma.employee.create({ data: { employeeCode: `EMP-9${String(Math.floor(Math.random() * 1e5)).padStart(5, "0")}`, fullName: `Existing ${tag}` } });
    const r = await track(createUserWithAccess(rawPrisma, { ...base("linked"), employee: { existingId: emp.id } }));
    expect(r.ok).toBe(true);
    expect((await rawPrisma.employee.findUniqueOrThrow({ where: { id: emp.id } })).userId).toBe(r.ok ? r.userId : null);
    const again = await createUserWithAccess(rawPrisma, { ...base("linked2"), employee: { existingId: emp.id } });
    expect(again).toEqual({ ok: false, error: "That employee already has a login." });
  });

  it("is all-or-nothing: an invalid employee leaves no login and no access behind", async () => {
    const d = await createDepartment(rawPrisma, { name: `Gone ${tag}` });
    if (!d.ok) throw new Error(d.error);
    created.departments.push(d.id);
    await setDepartmentActive(rawPrisma, d.id, false);
    const r = await createUserWithAccess(rawPrisma, {
      ...base("atomic"),
      employee: { create: { fullName: `Atomic ${tag}`, departmentId: d.id } },
      access: [{ projectId: bizId, level: "WRITE" }],
    });
    expect(r.ok).toBe(false);
    expect(await rawPrisma.user.count({ where: { username: `atomic_${tag}` } })).toBe(0);
    expect(await rawPrisma.employee.count({ where: { fullName: `Atomic ${tag}` } })).toBe(0);
  });

  it("refuses the same things the portal's App Users page refuses", async () => {
    await track(createUserWithAccess(rawPrisma, base("dupe")));
    expect(await createUserWithAccess(rawPrisma, base("dupe"))).toEqual({ ok: false, error: `A user named "dupe_${tag}" already exists.` });
    expect((await createUserWithAccess(rawPrisma, { ...base("short"), password: "short", confirmPassword: "short" })).ok).toBe(false);
    expect((await createUserWithAccess(rawPrisma, { ...base("mismatch"), confirmPassword: "something else entirely" })).ok).toBe(false);
    // Stored trimmed and lowercase, as the App Users page stores it.
    expect((await createUserWithAccess(rawPrisma, { ...base("upper"), username: `  UPPER_${tag.toUpperCase()}  ` })).ok).toBe(true);
    const upper = await rawPrisma.user.findUnique({ where: { username: `upper_${tag}` } });
    expect(upper).not.toBeNull();
    if (upper) created.users.push(upper.id);
  });

  it("never gives access to an archived project", async () => {
    const r = await createUserWithAccess(rawPrisma, { ...base("arch"), access: [{ projectId: archivedId, level: "READ" }] });
    expect(r).toEqual({ ok: false, error: "One of those projects no longer exists or is archived." });
    expect(await rawPrisma.user.count({ where: { username: `arch_${tag}` } })).toBe(0);
  });
});

describe("editing one user's project access", () => {
  it("grants, changes the level, and removes — and says when nothing changed", async () => {
    const r = await track(createUserWithAccess(rawPrisma, base("edit")));
    if (!r.ok) throw new Error(r.error);
    const read = () => rawPrisma.projectAccess.findUnique({ where: { projectId_userId: { projectId: bizId, userId: r.userId } } });
    expect(await setUserProjectAccess(rawPrisma, r.userId, bizId, "READ")).toEqual({ ok: true, changed: "granted" });
    expect((await read())?.level).toBe("READ");
    expect(await setUserProjectAccess(rawPrisma, r.userId, bizId, "READ")).toEqual({ ok: true, changed: "unchanged" });
    expect(await setUserProjectAccess(rawPrisma, r.userId, bizId, "FULL")).toEqual({ ok: true, changed: "updated" });
    expect((await read())?.level).toBeNull();
    const matrix = await userAccessMatrix(rawPrisma, r.userId);
    expect(matrix.find((m) => m.projectId === bizId)?.level).toBe("FULL");
    expect(matrix.find((m) => m.projectId === archivedId)).toBeUndefined(); // archived projects are not offered
    expect(await setUserProjectAccess(rawPrisma, r.userId, bizId, null)).toEqual({ ok: true, changed: "removed" });
    expect(await read()).toBeNull();
    expect((await setUserProjectAccess(rawPrisma, r.userId, archivedId, "READ")).ok).toBe(false);
  });

  it("the list shows each user's employee, role and levels", async () => {
    const rows = await listAdminUsers(rawPrisma, `full_${tag}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role?.id).toBe(roleId);
    expect(rows[0]!.employee?.fullName).toBe(`Full Person ${tag}`);
    expect(rows[0]!.access.map((a) => a.level).sort()).toEqual(["FULL", "READ"]);
  });
});
