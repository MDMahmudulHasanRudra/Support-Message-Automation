import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma as rawPrisma } from "@support-automation/db";
import {
  createDepartment,
  createEmployee,
  createJobTitle,
  deleteDepartment,
  deleteJobTitle,
  linkEmployeeToUser,
  setDepartmentActive,
  updateDepartment,
  updateEmployee,
} from "@/server/configuration";

/**
 * Main Admin → Configuration (MAIN_ADMIN_WORKSPACE.md §5): departments, job titles and employees,
 * against the real database — the employee-code sequence, the unique columns and the "deactivate,
 * never delete what somebody uses" rule only exist there.
 */

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const ids = { departments: [] as string[], jobTitles: [] as string[], employees: [] as string[], users: [] as string[] };

async function dept(name: string, code?: string) {
  const r = await createDepartment(rawPrisma, { name: `${name} ${tag}`, code });
  if (!r.ok) throw new Error(r.error);
  ids.departments.push(r.id);
  return r.id;
}
async function employee(fullName: string, extra: Record<string, unknown> = {}) {
  const r = await createEmployee(rawPrisma, { fullName: `${fullName} ${tag}`, ...extra });
  if (!r.ok) throw new Error(r.error);
  ids.employees.push(r.id);
  return r;
}

beforeAll(async () => {
  const u = await rawPrisma.user.create({ data: { username: `cfg_${tag}`, email: `cfg_${tag}@example.test`, name: "Cfg", passwordHash: "x" } });
  const u2 = await rawPrisma.user.create({ data: { username: `cfg2_${tag}`, email: `cfg2_${tag}@example.test`, name: "Cfg2", passwordHash: "x" } });
  ids.users.push(u.id, u2.id);
});

afterAll(async () => {
  await rawPrisma.employee.deleteMany({ where: { id: { in: ids.employees } } });
  await rawPrisma.department.deleteMany({ where: { id: { in: ids.departments } } });
  await rawPrisma.jobTitle.deleteMany({ where: { id: { in: ids.jobTitles } } });
  await rawPrisma.user.deleteMany({ where: { id: { in: ids.users } } });
  await rawPrisma.$disconnect();
});

describe("departments and job titles", () => {
  it("validate their input and refuse duplicates with a sentence, not an exception", async () => {
    expect(await createDepartment(rawPrisma, { name: "  " })).toEqual({ ok: false, error: "Give the department a name." });
    expect((await createDepartment(rawPrisma, { name: `Bad ${tag}`, code: "a b" })).ok).toBe(false);
    await dept("Support", `S${tag.slice(0, 4)}`.toUpperCase());
    expect(await createDepartment(rawPrisma, { name: `Support ${tag}` })).toEqual({ ok: false, error: "Another department already has that name or code." });
    const t = await createJobTitle(rawPrisma, { name: `Executive ${tag}` });
    expect(t.ok).toBe(true);
    if (t.ok) ids.jobTitles.push(t.id);
    expect(await createJobTitle(rawPrisma, { name: `Executive ${tag}` })).toEqual({ ok: false, error: "That job title already exists." });
  });

  it("codes are stored upper-case, and an edit keeps the row", async () => {
    const id = await dept("Billing", "bill");
    expect((await rawPrisma.department.findUniqueOrThrow({ where: { id } })).code).toBe("BILL");
    expect((await updateDepartment(rawPrisma, id, { name: `Billing & Accounts ${tag}`, code: "BILL" })).ok).toBe(true);
    expect((await rawPrisma.department.findUniqueOrThrow({ where: { id } })).name).toBe(`Billing & Accounts ${tag}`);
  });

  it("one somebody is filed under cannot be deleted — only deactivated; an unused one can", async () => {
    const used = await dept("Field");
    const unused = await dept("Unused");
    await employee("Rakib", { departmentId: used });
    const refused = await deleteDepartment(rawPrisma, used);
    expect(refused.ok).toBe(false);
    expect(await rawPrisma.department.count({ where: { id: used } })).toBe(1);
    expect((await setDepartmentActive(rawPrisma, used, false)).ok).toBe(true);
    expect((await deleteDepartment(rawPrisma, unused)).ok).toBe(true);
    expect(await rawPrisma.department.count({ where: { id: unused } })).toBe(0);

    const title = await createJobTitle(rawPrisma, { name: `Lead ${tag}` });
    if (!title.ok) throw new Error(title.error);
    ids.jobTitles.push(title.id);
    await employee("Mitu", { jobTitleId: title.id });
    expect((await deleteJobTitle(rawPrisma, title.id)).ok).toBe(false);
  });

  it("a deactivated department cannot be given to a new employee", async () => {
    const d = await dept("Closed");
    await setDepartmentActive(rawPrisma, d, false);
    const r = await createEmployee(rawPrisma, { fullName: `Late ${tag}`, departmentId: d });
    expect(r).toEqual({ ok: false, error: "That department is deactivated. Choose another, or reactivate it first." });
  });
});

describe("employees", () => {
  it("get an ID from the sequence: EMP- and six digits, each one new", async () => {
    const a = await employee("Anika");
    const b = await employee("Bipul");
    expect(a.employeeCode).toMatch(/^EMP-\d{6}$/);
    expect(Number(b.employeeCode!.slice(4))).toBeGreaterThan(Number(a.employeeCode!.slice(4)));
  });

  it("created at the same instant, still get different IDs", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => createEmployee(rawPrisma, { fullName: `Rush ${i} ${tag}` })));
    for (const r of results) if (r.ok) ids.employees.push(r.id);
    expect(results.every((r) => r.ok)).toBe(true);
    const codes = results.map((r) => (r.ok ? r.employeeCode : ""));
    expect(new Set(codes).size).toBe(12);
  });

  it("the database refuses a code that is not EMP-nnnnnn", async () => {
    await expect(rawPrisma.employee.create({ data: { employeeCode: "X-1", fullName: `Bad ${tag}` } })).rejects.toThrow();
  });

  it("an edit never changes the ID", async () => {
    const e = await employee("Kamal");
    expect((await updateEmployee(rawPrisma, e.id, { fullName: `Kamal Hossain ${tag}`, phone: "+880 1711-000000" })).ok).toBe(true);
    const row = await rawPrisma.employee.findUniqueOrThrow({ where: { id: e.id } });
    expect(row.employeeCode).toBe(e.employeeCode);
    expect(row.fullName).toBe(`Kamal Hossain ${tag}`);
  });

  it("refuses a bad email, a bad phone and a duplicate email", async () => {
    expect((await createEmployee(rawPrisma, { fullName: "X", email: "not-an-email" })).ok).toBe(false);
    expect((await createEmployee(rawPrisma, { fullName: "X", phone: "call me" })).ok).toBe(false);
    await employee("Mail", { email: `dup_${tag}@example.test` });
    expect((await createEmployee(rawPrisma, { fullName: "Mail 2", email: `DUP_${tag}@example.test` })).ok).toBe(false);
  });

  it("one login per person, and one person per login", async () => {
    const a = await employee("Linked A");
    const b = await employee("Linked B");
    expect((await linkEmployeeToUser(rawPrisma, a.id, ids.users[0]!)).ok).toBe(true);
    const second = await linkEmployeeToUser(rawPrisma, b.id, ids.users[0]!);
    expect(second.ok).toBe(false);
    expect((await rawPrisma.employee.findUniqueOrThrow({ where: { id: b.id } })).userId).toBeNull();
    expect((await linkEmployeeToUser(rawPrisma, a.id, null)).ok).toBe(true);
    expect((await linkEmployeeToUser(rawPrisma, b.id, ids.users[0]!)).ok).toBe(true);
  });
});
