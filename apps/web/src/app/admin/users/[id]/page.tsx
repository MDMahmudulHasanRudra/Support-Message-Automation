import NextLink from "next/link";
import { notFound } from "next/navigation";
import { platformPrisma } from "@/server/db";
import { requireAdminSection } from "@/server/mainAdmin";
import { userAccessMatrix } from "@/server/adminUsers";
import { Alert, Badge, Card, PageHeader, SectionHeader } from "@/components/ui";
import { AccessMatrix, EmployeeLink, RoleControl } from "./UserAdminControls";

export const metadata = { title: "User" };

/**
 * One user as the Main Admin sees them: the person, the login, the role and the project access, with
 * each part editable only by a role that holds that part's existing key.
 */
export default async function AdminUserPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ created?: string }> }) {
  const { session, allowed, can } = await requireAdminSection("users.view");
  if (!allowed) {
    return (
      <Alert tone="warning" title="Your role does not include App Users">
        It needs View App Users.
      </Alert>
    );
  }
  const { id } = await params;
  const { created } = await searchParams;
  const user = await platformPrisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      username: true,
      name: true,
      email: true,
      isActive: true,
      lastLoginAt: true,
      createdAt: true,
      permissionModuleId: true,
      permissionModule: { select: { name: true, permissions: { where: { permission: { key: "projects.manage" } }, select: { permissionId: true } } } },
      employee: { select: { id: true, employeeCode: true, fullName: true, department: { select: { name: true } }, jobTitle: { select: { name: true } } } },
    },
  });
  if (!user) notFound();

  const [canEditRole, canAccess, canEmployees, roles, matrix] = await Promise.all([
    can("users.edit"),
    can("projects.manage"),
    can("configuration.manage"),
    platformPrisma.permissionModule.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    userAccessMatrix(platformPrisma, id),
  ]);
  const freeEmployees = canEmployees
    ? await platformPrisma.employee.findMany({ where: { userId: null, status: "ACTIVE" }, orderBy: { fullName: "asc" }, select: { id: true, employeeCode: true, fullName: true } })
    : [];
  const isMainAdmin = (user.permissionModule?.permissions.length ?? 0) > 0;

  return (
    <div className="space-y-6">
      <NextLink href="/admin/users" className="text-xs text-[color:var(--color-muted-foreground)] hover:underline">
        ← Users &amp; Permissions
      </NextLink>
      <PageHeader
        title={user.name}
        description={`@${user.username}${user.email ? ` · ${user.email}` : ""} · ${user.lastLoginAt ? `last signed in ${user.lastLoginAt.toISOString().slice(0, 10)}` : "never signed in"}`}
        actions={
          <div className="flex items-center gap-2">
            {isMainAdmin ? <Badge color="blue">Main Admin</Badge> : null}
            {user.isActive ? <Badge color="green">Active</Badge> : <Badge color="gray">Deactivated</Badge>}
          </div>
        }
      />
      {created ? <Alert tone="success">User created.</Alert> : null}

      <Card>
        <SectionHeader title="Employee" description="The person this login belongs to (Configuration → Employees)." />
        {user.employee ? (
          <p className="mb-3 text-[13px]">
            <span className="font-mono text-xs">{user.employee.employeeCode}</span>{" "}
            <NextLink href={`/admin/configuration/employees/${user.employee.id}`} className="font-medium hover:underline">
              {user.employee.fullName}
            </NextLink>
            <span className="text-[color:var(--color-muted-foreground)]">
              {user.employee.jobTitle ? ` · ${user.employee.jobTitle.name}` : ""}
              {user.employee.department ? ` · ${user.employee.department.name}` : ""}
            </span>
          </p>
        ) : (
          <p className="mb-3 text-[13px] text-[color:var(--color-muted-foreground)]">No employee linked.</p>
        )}
        {canEmployees ? <EmployeeLink userId={user.id} linked={user.employee?.id ?? null} freeEmployees={freeEmployees} /> : null}
      </Card>

      <Card>
        <SectionHeader title="Role" description="What they may do — the same in every project they can enter. Edit the roles themselves on Permission Modules." />
        <RoleControl userId={user.id} current={user.permissionModuleId} roles={roles} canEdit={canEditRole && user.id !== session.userId} />
        {user.id === session.userId ? <p className="mt-2 text-xs text-[color:var(--color-muted-foreground)]">You cannot change your own role.</p> : null}
      </Card>

      <Card>
        <SectionHeader
          title="Project access"
          description={
            isMainAdmin
              ? "As a Main Admin this user may enter every project. A level set here still narrows their role in that project — Full is never a bypass."
              : "Which projects they may enter, and how much of their role they may use in each. Removing access takes effect on their next click."
          }
        />
        <AccessMatrix userId={user.id} rows={matrix} canEdit={canAccess} />
        {!canAccess ? <p className="mt-2 text-xs text-[color:var(--color-muted-foreground)]">Changing project access needs Manage Projects and Project Access.</p> : null}
      </Card>

      <p className="text-xs text-[color:var(--color-muted-foreground)]">
        Password resets, sessions and deactivation are on{" "}
        <NextLink href="/admin/workspace?to=%2Fusers" className="underline">
          App Users
        </NextLink>
        .
      </p>
    </div>
  );
}
