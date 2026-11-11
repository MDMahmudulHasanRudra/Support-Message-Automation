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
      {departments.every((d) => !d.isActive) || jobTitles.every((j) => !j.isActive) ? (
        <Alert tone="info" title="Every employee has a department and a job title">
          {departments.every((d) => !d.isActive) && jobTitles.every((j) => !j.isActive)
            ? "You have none yet. Press + New beside each one below to add it right here, or set up "
            : departments.every((d) => !d.isActive)
              ? "You have no departments yet. Press + New beside Department to add one here, or set up "
              : "You have no job titles yet. Press + New beside Job title to add one here, or set up "}
          <NextLink href="/admin/configuration/departments" className="font-medium underline">
            Departments
          </NextLink>{" "}
          and{" "}
          <NextLink href="/admin/configuration/job-titles" className="font-medium underline">
            Job Titles
          </NextLink>{" "}
          first.
        </Alert>
      ) : null}
      <EmployeeForm departments={departments} jobTitles={jobTitles} canManage />
    </div>
  );
}
