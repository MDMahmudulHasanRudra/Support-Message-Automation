import NextLink from "next/link";
import { Plus } from "lucide-react";
import { PROJECT_ACCESS_LEVEL_LABELS } from "@support-automation/shared";
import { platformPrisma } from "@/server/db";
import { requireAdminSection } from "@/server/mainAdmin";
import { listAdminUsers } from "@/server/adminUsers";
import { Alert, Badge, Button, ButtonLink, Input, PageHeader, Table, Td, Th } from "@/components/ui";

export const metadata = { title: "Users & Permissions" };

/**
 * Main Admin → Users & Permissions (MAIN_ADMIN_WORKSPACE.md §5): every login on the installation with
 * the person behind it, their role and the projects they may enter — one place to see all four.
 * Roles themselves (Permission Modules) stay where they are; this links there.
 */
export default async function AdminUsersPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { allowed, can } = await requireAdminSection("users.view");
  const { q = "" } = await searchParams;
  if (!allowed) {
    return (
      <div>
        <PageHeader title="Users & Permissions" />
        <Alert tone="warning" title="Your role does not include App Users">
          It needs View App Users. An administrator can add it to your role on Permission Modules.
        </Alert>
      </div>
    );
  }
  const [users, canCreate, canPermissions] = await Promise.all([listAdminUsers(platformPrisma, q), can("users.create"), can("permissions.view")]);
  const projectCount = await platformPrisma.project.count({ where: { status: { not: "ARCHIVED" } } });

  return (
    <div>
      <PageHeader
        title="Users & Permissions"
        description="Each login, the employee it belongs to, its role (what it may do — the same in every project) and the projects it may enter, with a level that can only narrow the role."
        actions={
          <div className="flex gap-2">
            {canPermissions ? (
              <ButtonLink href="/admin/workspace?to=%2Fpermissions" variant="secondary" size="md">
                Roles (Permission Modules)
              </ButtonLink>
            ) : null}
            {canCreate ? (
              <ButtonLink href="/admin/users/new" variant="primary" size="md">
                <Plus className="size-4" aria-hidden />
                New user
              </ButtonLink>
            ) : null}
          </div>
        }
      />
      <form method="get" className="mb-4 flex max-w-lg gap-2">
        <Input name="q" defaultValue={q} placeholder="Search username, name or email" aria-label="Search users" />
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </form>
      <Table>
        <thead>
          <tr>
            <Th>User</Th>
            <Th>Employee</Th>
            <Th>Role</Th>
            <Th>Projects</Th>
            <Th>Status</Th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id} data-user={user.username}>
              <Td>
                <NextLink href={`/admin/users/${user.id}`} className="font-medium text-[color:var(--color-foreground)] hover:underline">
                  {user.name}
                </NextLink>
                <div className="font-mono text-xs text-[color:var(--color-muted-foreground)]">@{user.username}</div>
              </Td>
              <Td>
                {user.employee ? (
                  <span className="text-[13px]">
                    <span className="font-mono text-xs">{user.employee.employeeCode}</span> {user.employee.fullName}
                  </span>
                ) : (
                  <span className="text-xs text-[color:var(--color-muted-foreground)]">—</span>
                )}
              </Td>
              <Td>
                {user.role?.name ?? <span className="text-xs text-[color:var(--color-muted-foreground)]">No role</span>}
                {user.isMainAdmin ? (
                  <span className="ml-2">
                    <Badge color="blue">Main Admin</Badge>
                  </span>
                ) : null}
              </Td>
              <Td>
                {user.isMainAdmin && user.access.length === 0 ? (
                  <span className="text-xs text-[color:var(--color-muted-foreground)]">Every project ({projectCount})</span>
                ) : user.access.length === 0 ? (
                  <span className="text-xs text-[color:var(--color-warning-fg)]">No project access</span>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {user.access.map((a) => (
                      <Badge key={a.projectId} color={a.level === "FULL" ? "gray" : "yellow"}>
                        {a.projectName} · {PROJECT_ACCESS_LEVEL_LABELS[a.level]}
                      </Badge>
                    ))}
                  </div>
                )}
              </Td>
              <Td>{user.isActive ? <Badge color="green">Active</Badge> : <Badge color="gray">Deactivated</Badge>}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
