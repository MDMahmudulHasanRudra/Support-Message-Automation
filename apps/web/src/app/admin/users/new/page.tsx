import NextLink from "next/link";
import { platformPrisma } from "@/server/db";
import { requireAdminSection } from "@/server/mainAdmin";
import { Alert, PageHeader } from "@/components/ui";
import { NewUserForm } from "./NewUserForm";

export const metadata = { title: "New user" };

/**
 * Creating a user from the Main Admin Portal: the person, the login, the role and the project access,
 * in one step — four separate things, each shown only to a role that may set it.
 */
export default async function NewAdminUserPage() {
  const { allowed, can } = await requireAdminSection("users.create");
  if (!allowed) {
    return (
      <div>
        <PageHeader title="New user" />
        <Alert tone="warning" title="Your role cannot create users">
          It needs Create App Users.
        </Alert>
      </div>
    );
  }
  const [canAccess, canEmployees] = await Promise.all([can("projects.manage"), can("configuration.manage")]);
  const [roles, projects, freeEmployees, departments, jobTitles] = await Promise.all([
    platformPrisma.permissionModule.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, description: true } }),
    canAccess
      ? platformPrisma.project.findMany({ where: { status: { not: "ARCHIVED" } }, orderBy: { createdAt: "asc" }, select: { id: true, name: true, status: true } })
      : [],
    canEmployees
      ? platformPrisma.employee.findMany({ where: { userId: null, status: "ACTIVE" }, orderBy: { fullName: "asc" }, select: { id: true, employeeCode: true, fullName: true, email: true } })
      : [],
    canEmployees ? platformPrisma.department.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }) : [],
    canEmployees ? platformPrisma.jobTitle.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }) : [],
  ]);

  return (
    <div>
      <NextLink href="/admin/users" className="text-xs text-[color:var(--color-muted-foreground)] hover:underline">
        ← Users &amp; Permissions
      </NextLink>
      <PageHeader title="New user" description="The person, their login, their role and the projects they may enter. Nothing is saved until every part is valid." />
      <NewUserForm
        roles={roles}
        projects={projects}
        canAccess={canAccess}
        canEmployees={canEmployees}
        freeEmployees={freeEmployees}
        departments={departments}
        jobTitles={jobTitles}
      />
    </div>
  );
}
