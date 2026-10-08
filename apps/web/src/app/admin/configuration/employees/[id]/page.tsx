import NextLink from "next/link";
import { notFound } from "next/navigation";
import { platformPrisma } from "@/server/db";
import { requireAdminSection } from "@/server/mainAdmin";
import { Alert, Badge, Card, SectionHeader } from "@/components/ui";
import { EmployeeForm } from "../EmployeeForm";
import { EmployeeLoginControl, EmployeeStatusControl } from "./EmployeeControls";

export const metadata = { title: "Employee" };

export default async function EmployeePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string }> }) {
  const { allowed, can } = await requireAdminSection("configuration.view");
  if (!allowed) return null;
  const { id } = await params;
  const { saved } = await searchParams;
  const [employee, departments, jobTitles, canManage] = await Promise.all([
    platformPrisma.employee.findUnique({
      where: { id },
      select: {
        id: true,
        employeeCode: true,
        fullName: true,
        email: true,
        phone: true,
        departmentId: true,
        jobTitleId: true,
        joinedOn: true,
        status: true,
        user: { select: { id: true, username: true, name: true, isActive: true } },
      },
    }),
    platformPrisma.department.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, isActive: true } }),
    platformPrisma.jobTitle.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, isActive: true } }),
    can("configuration.manage"),
  ]);
  if (!employee) notFound();
  // Logins nobody is linked to yet — the only ones this person can be given.
  const freeLogins = canManage
    ? await platformPrisma.user.findMany({ where: { employee: null }, orderBy: { username: "asc" }, select: { id: true, username: true, name: true } })
    : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <NextLink href="/admin/configuration/employees" className="text-xs text-[color:var(--color-muted-foreground)] hover:underline">
          ← Employees
        </NextLink>
        <span className="flex-1" />
        <span className="font-mono text-sm text-[color:var(--color-foreground)]">{employee.employeeCode}</span>
        {employee.status === "ACTIVE" ? <Badge color="green">Active</Badge> : <Badge color="gray">Inactive</Badge>}
      </div>
      {saved ? <Alert tone="success">Saved.</Alert> : null}

      <EmployeeForm
        canManage={canManage}
        departments={departments}
        jobTitles={jobTitles}
        defaults={{
          ...employee,
          joinedOn: employee.joinedOn ? employee.joinedOn.toISOString().slice(0, 10) : null,
        }}
      />

      <Card>
        <SectionHeader title="Login" description="The app login this person uses, if any. One login per person; the login's role and project access are set under Users & Permissions." />
        {employee.user ? (
          <p className="mb-3 text-[13px]">
            <NextLink href={`/admin/users/${employee.user.id}`} className="font-medium hover:underline">
              {employee.user.name} <span className="font-mono text-xs text-[color:var(--color-muted-foreground)]">@{employee.user.username}</span>
            </NextLink>
            {employee.user.isActive ? null : <span className="ml-2 text-xs text-[color:var(--color-muted-foreground)]">(login deactivated)</span>}
          </p>
        ) : (
          <p className="mb-3 text-[13px] text-[color:var(--color-muted-foreground)]">No login linked.</p>
        )}
        {canManage ? <EmployeeLoginControl employeeId={employee.id} linkedUserId={employee.user?.id ?? null} freeLogins={freeLogins} /> : null}
      </Card>

      {canManage ? (
        <Card>
          <SectionHeader
            title="Status"
            description="Employees are never deleted — their record stays for history. Deactivating does not touch their login; deactivate that separately if they have left."
          />
          <EmployeeStatusControl employeeId={employee.id} active={employee.status === "ACTIVE"} />
        </Card>
      ) : null}
    </div>
  );
}
