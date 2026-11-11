import NextLink from "next/link";
import { Plus } from "lucide-react";
import type { Prisma } from "@prisma/client";
import { platformPrisma } from "@/server/db";
import { requireAdminSection } from "@/server/mainAdmin";
import { Badge, Button, ButtonLink, Input, Pagination, Select, Td, Th } from "@/components/ui";
import { LIST_SCROLL_BOX } from "@/lib/listPageSizes";
import { NextStep } from "../../NextStep";
import { ADMIN_LIST_DEFAULT_SIZE, ADMIN_LIST_PAGE_SIZES, listHref, readListPaging, SCROLL_TABLE_CLASS } from "../../listPaging";

export const metadata = { title: "Employees" };

/** The people in the organisation. A GET form filters, so a filtered list can be bookmarked like every other list here. */
export default async function EmployeesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; department?: string; status?: string; page?: string; size?: string }>;
}) {
  const { allowed, can } = await requireAdminSection("configuration.view");
  if (!allowed) return null;
  const params = await searchParams;
  const { q = "", department = "", status = "ACTIVE" } = params;
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

  const total = await platformPrisma.employee.count({ where });
  const { page, size, skip } = readListPaging(params, total);
  const href = (next: { page?: number; size?: number }) =>
    listHref("/admin/configuration/employees", { q: term, department, status: status === "ACTIVE" ? undefined : status, page: next.page, size: next.size ?? size });

  const [employees, departments, canManage] = await Promise.all([
    platformPrisma.employee.findMany({
      where,
      orderBy: { employeeCode: "asc" },
      skip,
      take: size,
      select: {
        id: true,
        employeeCode: true,
        fullName: true,
        email: true,
        status: true,
        department: { select: { name: true } },
        jobTitle: { select: { name: true } },
        user: { select: { id: true, username: true, isActive: true } },
      },
    }),
    platformPrisma.department.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    can("configuration.manage"),
  ]);
  const canCreateLogin = await can("users.create");
  const withoutLogin = canCreateLogin ? await platformPrisma.employee.count({ where: { status: "ACTIVE", userId: null } }) : 0;

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
          {size !== ADMIN_LIST_DEFAULT_SIZE ? <input type="hidden" name="size" value={size} /> : null}
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
        term || department || status !== "ACTIVE" ? (
          <p className="rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border-strong)] px-4 py-8 text-center text-[13px] text-[color:var(--color-muted-foreground)]">No employees match those filters.</p>
        ) : (
          <div className="rounded-[var(--radius-xl)] border border-dashed border-[var(--color-border-strong)] px-6 py-10 text-center">
            <p className="text-[15px] font-semibold text-[color:var(--color-foreground)]">Add the people who work here</p>
            <p className="mx-auto mt-1 max-w-md text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
              Each employee gets an ID automatically and is filed under a department and a job title. Then you can give them a login in one click.
            </p>
            {canManage ? (
              <div className="mt-4 flex justify-center">
                <ButtonLink href="/admin/configuration/employees/new" variant="primary">
                  <Plus className="size-4" aria-hidden />
                  Add your first employee
                </ButtonLink>
              </div>
            ) : null}
          </div>
        )
      ) : (
        <>
        <p className="text-xs text-[color:var(--color-muted-foreground)] tabular-nums">
          Showing {employees.length.toLocaleString("en-US")} of {total.toLocaleString("en-US")} employee{total === 1 ? "" : "s"}
          {term || department || status !== "ACTIVE" ? " matching these filters" : ""}.
        </p>
        <div className={`${LIST_SCROLL_BOX} rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xs),var(--highlight-top)]`}>
        <table className={SCROLL_TABLE_CLASS}>
          <thead>
            <tr>
              <Th>Employee ID</Th>
              <Th>Name</Th>
              <Th>Department</Th>
              <Th>Job title</Th>
              <Th>App access</Th>
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
                    <NextLink href={`/admin/users/${e.user.id}`} className="inline-flex items-center gap-2 hover:underline">
                      <Badge color={e.user.isActive ? "green" : "gray"} dot>
                        {e.user.isActive ? "Active user" : "Access disabled"}
                      </Badge>
                      <span className="font-mono text-xs text-[color:var(--color-muted-foreground)]">@{e.user.username}</span>
                    </NextLink>
                  ) : canCreateLogin && e.status === "ACTIVE" ? (
                    <NextLink href={`/admin/users/new?employee=${e.id}`} className="text-xs font-medium text-[color:var(--color-accent-fg)] hover:underline">
                      Give app access
                    </NextLink>
                  ) : (
                    <span className="text-xs text-[color:var(--color-muted-foreground)]">No app access</span>
                  )}
                </Td>
                <Td>{e.status === "ACTIVE" ? <Badge color="green">Active</Badge> : <Badge color="gray">Inactive</Badge>}</Td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        <Pagination
          page={page}
          pageSize={size}
          total={total}
          buildHref={(n) => href({ page: n })}
          pageSizeOptions={ADMIN_LIST_PAGE_SIZES}
          buildPageSizeHref={(n) => href({ size: n })}
        />
        {withoutLogin > 0 ? (
          <NextStep
            title={`${withoutLogin} ${withoutLogin === 1 ? "employee has" : "employees have"} no app access`}
            detail="Press Give app access in the App access column to create their login, role and projects in one step."
            href={`/admin/configuration/employees?status=ACTIVE`}
            action="Show them"
          />
        ) : null}
        </>
      )}
    </div>
  );
}
