import NextLink from "next/link";
import { platformPrisma } from "@/server/db";
import { requireAdminSection } from "@/server/mainAdmin";
import { Alert } from "@/components/ui";
import { EmployeeForm } from "../EmployeeForm";

export const metadata = { title: "New employee" };

export default async function NewEmployeePage() {
  const { allowed, can } = await requireAdminSection("configuration.view");
  if (!allowed) return null;
  if (!(await can("configuration.manage"))) {
    return (
      <Alert tone="warning" title="Your role cannot add employees">
        It needs Manage Departments, Job Titles &amp; Employees.
      </Alert>
    );
  }
  const [departments, jobTitles] = await Promise.all([
    platformPrisma.department.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, isActive: true } }),
    platformPrisma.jobTitle.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, isActive: true } }),
  ]);
  return (
    <div className="space-y-4">
      <NextLink href="/admin/configuration/employees" className="text-xs text-[color:var(--color-muted-foreground)] hover:underline">
        ← Employees
      </NextLink>
      <EmployeeForm departments={departments} jobTitles={jobTitles} canManage />
    </div>
  );
}
