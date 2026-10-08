import NextLink from "next/link";
import { Plus } from "lucide-react";
import type { Prisma } from "@prisma/client";
import { platformPrisma } from "@/server/db";
import { requireAdminSection } from "@/server/mainAdmin";
import { Badge, Button, ButtonLink, Input, Select, Table, Td, Th } from "@/components/ui";

export const metadata = { title: "Employees" };

/** The people in the organisation. A GET form filters, so a filtered list can be bookmarked like every other list here. */
export default async function EmployeesPage({ searchParams }: { searchParams: Promise<{ q?: string; department?: string; status?: string }> }) {
  const { allowed, can } = await requireAdminSection("configuration.view");
  if (!allowed) return null;
  const { q = "", department = "", status = "ACTIVE" } = await searchParams;
  const where: Prisma.EmployeeWhereInput = {};
  const term = q.trim();
  if (term) {
    where.OR = [
      { fullName: { contains: term, mode: "insensitive" } },
      { employeeCode: { contains: term, mode: "insensitive" } },
      { email: { contains: term, mode: "insensitive" } },
      { phone: { contains: term } },
    ];
  }
  if (department) where.departmentId = department;
  if (status === "ACTIVE" || status === "INACTIVE") where.status = status;

  const [employees, departments, canManage] = await Promise.all([
    platformPrisma.employee.findMany({
      where,
      orderBy: { employeeCode: "asc" },
      take: 500,
      select: {
        id: true,
        employeeCode: true,
        fullName: true,
        email: true,
        status: true,
        department: { select: { name: true } },
        jobTitle: { select: { name: true } },
        user: { select: { id: true, username: true } },
      },
    }),
    platformPrisma.department.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    can("configuration.manage"),
  ]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <form className="flex flex-1 flex-wrap items-end gap-2" method="get">
          <div className="min-w-[12rem] flex-1">
            <Input name="q" defaultValue={q} placeholder="Search name, ID, email or phone" aria-label="Search employees" />
          </div>
          <div className="w-44">
            <Select name="department" defaultValue={department} aria-label="Department">
              <option value="">All departments</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="w-36">
            <Select name="status" defaultValue={status} aria-label="Status">
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Inactive</option>
              <option value="ALL">All</option>
            </Select>
          </div>
          <Button type="submit" variant="secondary">
            Filter
          </Button>
        </form>
        {canManage ? (
          <ButtonLink href="/admin/configuration/employees/new" variant="primary" size="md">
            <Plus className="size-4" aria-hidden />
            Add employee
          </ButtonLink>
        ) : null}
      </div>

      {employees.length === 0 ? (
        <p className="rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border-strong)] px-4 py-8 text-center text-[13px] text-[color:var(--color-muted-foreground)]">
          {term || department || status !== "ACTIVE" ? "No employees match those filters." : "No employees recorded yet."}
        </p>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Employee ID</Th>
              <Th>Name</Th>
              <Th>Department</Th>
              <Th>Job title</Th>
              <Th>Login</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {employees.map((e) => (
              <tr key={e.id}>
                <Td className="font-mono text-xs">{e.employeeCode}</Td>
                <Td>
                  <NextLink href={`/admin/configuration/employees/${e.id}`} className="font-medium text-[color:var(--color-foreground)] hover:underline">
                    {e.fullName}
                  </NextLink>
                  {e.email ? <div className="text-xs text-[color:var(--color-muted-foreground)]">{e.email}</div> : null}
                </Td>
                <Td>{e.department?.name ?? "—"}</Td>
                <Td>{e.jobTitle?.name ?? "—"}</Td>
                <Td>
                  {e.user ? (
                    <NextLink href={`/admin/users/${e.user.id}`} className="font-mono text-xs hover:underline">
                      @{e.user.username}
                    </NextLink>
                  ) : (
                    <span className="text-xs text-[color:var(--color-muted-foreground)]">No login</span>
                  )}
                </Td>
                <Td>{e.status === "ACTIVE" ? <Badge color="green">Active</Badge> : <Badge color="gray">Inactive</Badge>}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
