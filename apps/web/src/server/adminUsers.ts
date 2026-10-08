import type { PrismaClient } from "@prisma/client";
import { isProjectAccessLevel, type ProjectAccessLevelValue, type ProjectStatusValue } from "@support-automation/shared";
import { hashPassword } from "@/server/auth";
import { createEmployee, type EmployeeInput } from "@/server/configuration";
import { isUniqueViolation } from "@/lib/prismaErrors";
import { MIN_PASSWORD_LENGTH, normalizeUsername } from "@/lib/userRules";

/**
 * Main Admin → Users & Permissions (MAIN_ADMIN_WORKSPACE.md §5): a login, the person behind it, their
 * role and the projects they may enter, handled together. Four separate things, kept separate:
 *
 *   Employee        the person (Configuration → Employees) — optional, one per login
 *   Login           `User`: username, password, name
 *   Role            the EXISTING Permission Module — what they may do, the same in every project
 *   Project access  which projects they may enter, each with an optional level that only narrows
 *
 * Platform data throughout, so these take the platform client. The Server Actions in
 * `server/actions/adminUsers.ts` check who may do each part.
 */

export interface AccessGrant {
  projectId: string;
  level: ProjectAccessLevelValue;
}

export interface NewUserInput {
  username: unknown;
  name: unknown;
  email?: unknown;
  password: unknown;
  confirmPassword: unknown;
  permissionModuleId?: unknown;
  /** Link an existing employee, or create one with the login (never both). */
  employee?: { existingId: string } | { create: EmployeeInput } | null;
  access: AccessGrant[];
}

export type NewUserResult = { ok: true; userId: string; employeeCode?: string } | { ok: false; error: string };

/** Everything is written in one transaction: no login is left without the access it was given, or the reverse. */
export async function createUserWithAccess(db: PrismaClient, input: NewUserInput): Promise<NewUserResult> {
  const username = normalizeUsername(input.username);
  const name = String(input.name ?? "").trim();
  const email = String(input.email ?? "").trim().toLowerCase() || null;
  const password = String(input.password ?? "");
  const permissionModuleId = String(input.permissionModuleId ?? "").trim() || null;

  if (!username) return { ok: false, error: "Username is required." };
  if (!name) return { ok: false, error: "Display name is required." };
  if (password.length < MIN_PASSWORD_LENGTH) return { ok: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  if (password !== String(input.confirmPassword ?? "")) return { ok: false, error: "Passwords do not match." };
  if (await db.user.findUnique({ where: { username }, select: { id: true } })) return { ok: false, error: `A user named "${username}" already exists.` };
  if (email && (await db.user.findUnique({ where: { email }, select: { id: true } }))) return { ok: false, error: "Another user already has that email address." };
  if (permissionModuleId && !(await db.permissionModule.findUnique({ where: { id: permissionModuleId }, select: { id: true } }))) {
    return { ok: false, error: "That role no longer exists." };
  }

  const projectIds = [...new Set(input.access.map((a) => a.projectId))];
  if (projectIds.length !== input.access.length) return { ok: false, error: "A project was listed twice." };
  if (input.access.some((a) => !isProjectAccessLevel(a.level))) return { ok: false, error: "Choose Read, Write or Full for each project." };
  if (projectIds.length > 0) {
    const found = await db.project.findMany({ where: { id: { in: projectIds }, status: { not: "ARCHIVED" } }, select: { id: true } });
    if (found.length !== projectIds.length) return { ok: false, error: "One of those projects no longer exists or is archived." };
  }

  if (input.employee && "existingId" in input.employee) {
    const existing = await db.employee.findUnique({ where: { id: input.employee.existingId }, select: { userId: true, status: true } });
    if (!existing) return { ok: false, error: "That employee no longer exists." };
    if (existing.userId) return { ok: false, error: "That employee already has a login." };
    if (existing.status !== "ACTIVE") return { ok: false, error: "That employee is inactive. Reactivate them first." };
  }

  try {
    return await db.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { username, name, email, passwordHash: hashPassword(password), permissionModuleId },
        select: { id: true },
      });
      let employeeCode: string | undefined;
      if (input.employee && "existingId" in input.employee) {
        await tx.employee.update({ where: { id: input.employee.existingId }, data: { userId: user.id } });
      } else if (input.employee && "create" in input.employee) {
        const created = await createEmployee(tx, { ...input.employee.create, userId: user.id });
        if (!created.ok) throw new InputError(created.error);
        employeeCode = created.employeeCode;
      }
      if (input.access.length > 0) {
        await tx.projectAccess.createMany({
          // FULL is stored as null: it is what "no narrowing" has always meant on this table.
          data: input.access.map((a) => ({ projectId: a.projectId, userId: user.id, level: a.level === "FULL" ? null : a.level })),
        });
      }
      return { ok: true as const, userId: user.id, employeeCode };
    });
  } catch (err) {
    if (err instanceof InputError) return { ok: false, error: err.message };
    if (isUniqueViolation(err)) return { ok: false, error: "That username, email or employee was just taken. Nothing was saved." };
    throw err;
  }
}

class InputError extends Error {}

/**
 * Sets one user's access to one project: none (removed), or a level. The level only narrows their
 * existing role; FULL is stored as null.
 */
export async function setUserProjectAccess(
  db: PrismaClient,
  userId: string,
  projectId: string,
  level: ProjectAccessLevelValue | null,
): Promise<{ ok: true; changed: "granted" | "updated" | "removed" | "unchanged" } | { ok: false; error: string }> {
  const [user, project] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { id: true } }),
    db.project.findUnique({ where: { id: projectId }, select: { id: true, status: true } }),
  ]);
  if (!user) return { ok: false, error: "That user no longer exists." };
  if (!project) return { ok: false, error: "That project no longer exists." };
  const existing = await db.projectAccess.findUnique({ where: { projectId_userId: { projectId, userId } }, select: { level: true } });
  if (level === null) {
    if (!existing) return { ok: true, changed: "unchanged" };
    await db.projectAccess.deleteMany({ where: { projectId, userId } });
    return { ok: true, changed: "removed" };
  }
  if (!isProjectAccessLevel(level)) return { ok: false, error: "Choose Read, Write or Full." };
  const stored = level === "FULL" ? null : level;
  if (!existing) {
    if (project.status === "ARCHIVED") return { ok: false, error: "That project is archived; nobody new can be given access." };
    await db.projectAccess.create({ data: { projectId, userId, level: stored } });
    return { ok: true, changed: "granted" };
  }
  if ((existing.level ?? null) === stored) return { ok: true, changed: "unchanged" };
  await db.projectAccess.update({ where: { projectId_userId: { projectId, userId } }, data: { level: stored } });
  return { ok: true, changed: "updated" };
}

export interface AdminUserRow {
  id: string;
  username: string;
  name: string;
  email: string | null;
  isActive: boolean;
  lastLoginAt: Date | null;
  role: { id: string; name: string } | null;
  isMainAdmin: boolean;
  employee: { id: string; employeeCode: string; fullName: string } | null;
  access: Array<{ projectId: string; projectName: string; projectSlug: string; level: ProjectAccessLevelValue }>;
}

export async function listAdminUsers(db: PrismaClient, search = ""): Promise<AdminUserRow[]> {
  const q = search.trim();
  const users = await db.user.findMany({
    where: q
      ? { OR: [{ username: { contains: q, mode: "insensitive" } }, { name: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }] }
      : {},
    orderBy: { username: "asc" },
    select: {
      id: true,
      username: true,
      name: true,
      email: true,
      isActive: true,
      lastLoginAt: true,
      permissionModule: { select: { id: true, name: true, permissions: { where: { permission: { key: "projects.manage" } }, select: { permissionId: true } } } },
      employee: { select: { id: true, employeeCode: true, fullName: true } },
      projectAccess: { select: { level: true, project: { select: { id: true, name: true, slug: true, createdAt: true } } } },
    },
  });
  return users.map((u) => ({
    id: u.id,
    username: u.username,
    name: u.name,
    email: u.email,
    isActive: u.isActive,
    lastLoginAt: u.lastLoginAt,
    role: u.permissionModule ? { id: u.permissionModule.id, name: u.permissionModule.name } : null,
    isMainAdmin: (u.permissionModule?.permissions.length ?? 0) > 0,
    employee: u.employee,
    access: u.projectAccess
      .sort((a, b) => a.project.createdAt.getTime() - b.project.createdAt.getTime())
      .map((a) => ({ projectId: a.project.id, projectName: a.project.name, projectSlug: a.project.slug, level: a.level ?? "FULL" })),
  }));
}

export interface AccessMatrixRow {
  projectId: string;
  name: string;
  slug: string;
  status: ProjectStatusValue;
  /** null = no access. */
  level: ProjectAccessLevelValue | null;
}

/** Every non-archived project, with this user's access to each — the grid on a user's page. */
export async function userAccessMatrix(db: PrismaClient, userId: string): Promise<AccessMatrixRow[]> {
  const [projects, rows] = await Promise.all([
    db.project.findMany({ where: { status: { not: "ARCHIVED" } }, orderBy: { createdAt: "asc" }, select: { id: true, name: true, slug: true, status: true } }),
    db.projectAccess.findMany({ where: { userId }, select: { projectId: true, level: true } }),
  ]);
  const byProject = new Map(rows.map((r) => [r.projectId, r.level ?? "FULL"] as const));
  return projects.map((p) => ({ projectId: p.id, name: p.name, slug: p.slug, status: p.status as ProjectStatusValue, level: byProject.get(p.id) ?? null }));
}
