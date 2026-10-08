import type { Prisma, PrismaClient } from "@prisma/client";
import { isUniqueViolation } from "@/lib/prismaErrors";

/**
 * Main Admin → Configuration (MAIN_ADMIN_WORKSPACE.md §5): the organisation's departments, job
 * titles and employees. Platform data — none of it carries a projectId — so everything here takes the
 * PLATFORM client explicitly. The Server Actions in `server/actions/configuration.ts` do the
 * permission checks and call these; keeping the rules here lets them be tested without a request.
 *
 * Records with history are never deleted out from under it: a department or job title somebody is
 * filed under is deactivated instead, and an employee is only ever deactivated.
 */

export type ConfigResult = { ok: true; id: string } | { ok: false; error: string };

type Db = PrismaClient | Prisma.TransactionClient;

const clean = (value: unknown, max: number): string => String(value ?? "").trim().slice(0, max);
const optional = (value: unknown, max: number): string | null => clean(value, max) || null;

// ── Departments ──────────────────────────────────────────────────────────────────────────────────

export interface DepartmentInput {
  name: unknown;
  code?: unknown;
  description?: unknown;
}

function readDepartment(input: DepartmentInput): { name: string; code: string | null; description: string | null } | string {
  const name = clean(input.name, 100);
  if (!name) return "Give the department a name.";
  const code = optional(input.code, 12)?.toUpperCase() ?? null;
  if (code && !/^[A-Z0-9-]+$/.test(code)) return "A department code may use letters, numbers and hyphens only.";
  return { name, code, description: optional(input.description, 500) };
}

export async function createDepartment(db: Db, input: DepartmentInput): Promise<ConfigResult> {
  const data = readDepartment(input);
  if (typeof data === "string") return { ok: false, error: data };
  try {
    return { ok: true, id: (await db.department.create({ data, select: { id: true } })).id };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, error: "Another department already has that name or code." };
    throw err;
  }
}

export async function updateDepartment(db: Db, id: string, input: DepartmentInput): Promise<ConfigResult> {
  const data = readDepartment(input);
  if (typeof data === "string") return { ok: false, error: data };
  if (!(await db.department.findUnique({ where: { id }, select: { id: true } }))) return { ok: false, error: "That department no longer exists." };
  try {
    await db.department.update({ where: { id }, data });
    return { ok: true, id };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, error: "Another department already has that name or code." };
    throw err;
  }
}

export async function setDepartmentActive(db: Db, id: string, isActive: boolean): Promise<ConfigResult> {
  const updated = await db.department.updateMany({ where: { id }, data: { isActive } });
  return updated.count ? { ok: true, id } : { ok: false, error: "That department no longer exists." };
}

/** Deletes only a department nobody is filed under; otherwise says to deactivate it. */
export async function deleteDepartment(db: Db, id: string): Promise<ConfigResult> {
  const inUse = await db.employee.count({ where: { departmentId: id } });
  if (inUse > 0) return { ok: false, error: `${inUse} employee(s) are in this department, so it can only be deactivated.` };
  const deleted = await db.department.deleteMany({ where: { id } });
  return deleted.count ? { ok: true, id } : { ok: false, error: "That department no longer exists." };
}

// ── Job titles ───────────────────────────────────────────────────────────────────────────────────

export interface JobTitleInput {
  name: unknown;
  description?: unknown;
}

function readJobTitle(input: JobTitleInput): { name: string; description: string | null } | string {
  const name = clean(input.name, 100);
  if (!name) return "Give the job title a name.";
  return { name, description: optional(input.description, 500) };
}

export async function createJobTitle(db: Db, input: JobTitleInput): Promise<ConfigResult> {
  const data = readJobTitle(input);
  if (typeof data === "string") return { ok: false, error: data };
  try {
    return { ok: true, id: (await db.jobTitle.create({ data, select: { id: true } })).id };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, error: "That job title already exists." };
    throw err;
  }
}

export async function updateJobTitle(db: Db, id: string, input: JobTitleInput): Promise<ConfigResult> {
  const data = readJobTitle(input);
  if (typeof data === "string") return { ok: false, error: data };
  if (!(await db.jobTitle.findUnique({ where: { id }, select: { id: true } }))) return { ok: false, error: "That job title no longer exists." };
  try {
    await db.jobTitle.update({ where: { id }, data });
    return { ok: true, id };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, error: "That job title already exists." };
    throw err;
  }
}

export async function setJobTitleActive(db: Db, id: string, isActive: boolean): Promise<ConfigResult> {
  const updated = await db.jobTitle.updateMany({ where: { id }, data: { isActive } });
  return updated.count ? { ok: true, id } : { ok: false, error: "That job title no longer exists." };
}

export async function deleteJobTitle(db: Db, id: string): Promise<ConfigResult> {
  const inUse = await db.employee.count({ where: { jobTitleId: id } });
  if (inUse > 0) return { ok: false, error: `${inUse} employee(s) have this job title, so it can only be deactivated.` };
  const deleted = await db.jobTitle.deleteMany({ where: { id } });
  return deleted.count ? { ok: true, id } : { ok: false, error: "That job title no longer exists." };
}

// ── Employees ────────────────────────────────────────────────────────────────────────────────────

/**
 * The next employee code, "EMP-000001" onward, from the database sequence. Unique and never reused
 * even when two people are created at once — the sequence hands each transaction its own number —
 * and never derived from a name or a count, which would repeat after a deletion or a race.
 */
export async function nextEmployeeCode(db: Db): Promise<string> {
  const [row] = await db.$queryRaw<Array<{ n: bigint }>>`SELECT nextval('employee_code_seq') AS n`;
  return `EMP-${String(row!.n).padStart(6, "0")}`;
}

export interface EmployeeInput {
  fullName: unknown;
  email?: unknown;
  phone?: unknown;
  departmentId?: unknown;
  jobTitleId?: unknown;
  joinedOn?: unknown;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function readEmployee(db: Db, input: EmployeeInput) {
  const fullName = clean(input.fullName, 150);
  if (!fullName) return "Enter the employee's full name.";
  const email = optional(input.email, 200)?.toLowerCase() ?? null;
  if (email && !EMAIL_RE.test(email)) return "That email address does not look right.";
  const phone = optional(input.phone, 40);
  if (phone && !/^[+0-9 ()-]{6,40}$/.test(phone)) return "A phone number may use digits, spaces, +, - and brackets only.";
  const departmentId = optional(input.departmentId, 64);
  if (departmentId) {
    const d = await db.department.findUnique({ where: { id: departmentId }, select: { isActive: true } });
    if (!d) return "That department no longer exists.";
    if (!d.isActive) return "That department is deactivated. Choose another, or reactivate it first.";
  }
  const jobTitleId = optional(input.jobTitleId, 64);
  if (jobTitleId) {
    const j = await db.jobTitle.findUnique({ where: { id: jobTitleId }, select: { isActive: true } });
    if (!j) return "That job title no longer exists.";
    if (!j.isActive) return "That job title is deactivated. Choose another, or reactivate it first.";
  }
  const joinedRaw = optional(input.joinedOn, 10);
  let joinedOn: Date | null = null;
  if (joinedRaw) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(joinedRaw) || Number.isNaN(Date.parse(`${joinedRaw}T00:00:00Z`))) return "Enter the joining date as a date.";
    joinedOn = new Date(`${joinedRaw}T00:00:00Z`);
  }
  return { fullName, email, phone, departmentId, jobTitleId, joinedOn };
}

/** Creates an employee with the next code. Pass a transaction to create it together with other rows. */
export async function createEmployee(db: Db, input: EmployeeInput & { userId?: string | null }): Promise<ConfigResult & { employeeCode?: string }> {
  const data = await readEmployee(db, input);
  if (typeof data === "string") return { ok: false, error: data };
  try {
    const employeeCode = await nextEmployeeCode(db);
    const created = await db.employee.create({ data: { ...data, employeeCode, userId: input.userId ?? null }, select: { id: true, employeeCode: true } });
    return { ok: true, id: created.id, employeeCode: created.employeeCode };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, error: "Another employee already has that email address, or that login is already linked to someone." };
    throw err;
  }
}

/** Edits an employee. The code is never changed — it is the person's identifier. */
export async function updateEmployee(db: Db, id: string, input: EmployeeInput): Promise<ConfigResult> {
  if (!(await db.employee.findUnique({ where: { id }, select: { id: true } }))) return { ok: false, error: "That employee no longer exists." };
  const data = await readEmployee(db, input);
  if (typeof data === "string") return { ok: false, error: data };
  try {
    await db.employee.update({ where: { id }, data });
    return { ok: true, id };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, error: "Another employee already has that email address." };
    throw err;
  }
}

export async function setEmployeeStatus(db: Db, id: string, status: "ACTIVE" | "INACTIVE"): Promise<ConfigResult> {
  const updated = await db.employee.updateMany({ where: { id }, data: { status } });
  return updated.count ? { ok: true, id } : { ok: false, error: "That employee no longer exists." };
}

/**
 * Links an employee to a login, or unlinks them (userId null). One login per person and one person
 * per login — the unique column refuses a second link, and this says so rather than moving it.
 */
export async function linkEmployeeToUser(db: Db, employeeId: string, userId: string | null): Promise<ConfigResult> {
  if (!(await db.employee.findUnique({ where: { id: employeeId }, select: { id: true } }))) return { ok: false, error: "That employee no longer exists." };
  if (userId) {
    if (!(await db.user.findUnique({ where: { id: userId }, select: { id: true } }))) return { ok: false, error: "That login no longer exists." };
    const holder = await db.employee.findUnique({ where: { userId }, select: { id: true, fullName: true } });
    if (holder && holder.id !== employeeId) return { ok: false, error: `That login already belongs to ${holder.fullName}. Unlink it there first.` };
  }
  try {
    await db.employee.update({ where: { id: employeeId }, data: { userId } });
    return { ok: true, id: employeeId };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, error: "That login was just linked to someone else." };
    throw err;
  }
}
