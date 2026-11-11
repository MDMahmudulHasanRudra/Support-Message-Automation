import NextLink from "next/link";
import { notFound } from "next/navigation";
import { platformPrisma } from "@/server/db";
import { requireAdminSection } from "@/server/mainAdmin";
import { KeyRound } from "lucide-react";
import { Alert, Badge, ButtonLink, Card, SectionHeader } from "@/components/ui";
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
  const canCreateLogin = await can("users.create");
  // Logins nobody is linked to yet — the only ones this person can be given.
  const freeLogins = canManage
    ? await platformPrisma.user.findMany({ where: { employee: null }, orderBy: { username: "asc" }, select: { id: true, username: true, name: true } })
    : [];

  return (
    <div className="space-y-6">
      <div>
        <NextLink href="/admin/configuration/employees" className="text-xs text-[color:var(--color-muted-foreground)] hover:underline">
          ← Employees
        </NextLink>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h2 className="min-w-0 text-xl font-semibold tracking-[-0.015em] text-[color:var(--color-foreground)]">{employee.fullName}</h2>
          <span className="font-mono text-sm text-[color:var(--color-muted-foreground)]">{employee.employeeCode}</span>
          {employee.status === "ACTIVE" ? <Badge color="green">Active</Badge> : <Badge color="gray">Inactive</Badge>}
        </div>
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
        <SectionHeader
          title="App access"
          description="Whether this person can sign in, and to what. One login per person; its role and projects are set under Users & Access."
          action={
            !employee.user && canCreateLogin && employee.status === "ACTIVE" ? (
              <ButtonLink href={`/admin/users/new?employee=${employee.id}`} variant="primary">
                <KeyRound className="size-4" aria-hidden />
                Give app access
              </ButtonLink>
            ) : null
          }
        />
        {employee.user ? (
          <p className="mb-3 text-[13px]">
            <NextLink href={`/admin/users/${employee.user.id}`} className="font-medium hover:underline">
              {employee.user.name} <span className="font-mono text-xs text-[color:var(--color-muted-foreground)]">@{employee.user.username}</span>
            </NextLink>
            {employee.user.isActive ? null : <span className="ml-2 text-xs text-[color:var(--color-muted-foreground)]">(login deactivated)</span>}
          </p>
        ) : (
          <p className="mb-3 text-[13px] text-[color:var(--color-muted-foreground)]">No app access yet. Give access to create their login, role and projects in one step, or link a login that already exists.</p>
        )}
        {canManage ? <EmployeeLoginControl employeeId={employee.id} linkedUserId={employee.user?.id ?? null} freeLogins={freeLogins} /> : null}
      </Card>

      {canManage ? (
        <Card>
          <SectionHeader
            title="Status"
            description="Employees are never deleted — their record stays for history. Deactivating does not touch their login; deactivate that separately if they have left."
          />
          <EmployeeStatusControl employeeId={employee.id} employeeName={employee.fullName} hasLogin={Boolean(employee.user)} active={employee.status === "ACTIVE"} />
        </Card>
      ) : null}
    </div>
  );
}
