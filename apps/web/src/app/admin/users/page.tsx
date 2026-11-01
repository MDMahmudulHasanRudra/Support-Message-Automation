import NextLink from "next/link";
import { Plus } from "lucide-react";
import { PROJECT_ACCESS_LEVEL_LABELS } from "@support-automation/shared";
import { platformPrisma } from "@/server/db";
import { requireAdminSection } from "@/server/mainAdmin";
import { countAdminUsers, listAdminUsers } from "@/server/adminUsers";
import { Alert, Badge, ButtonLink, PageHeader, Pagination, SearchField, Td, Th } from "@/components/ui";
import { LIST_SCROLL_BOX } from "@/lib/listPageSizes";
import { ADMIN_LIST_DEFAULT_SIZE, ADMIN_LIST_PAGE_SIZES, listHref, readListPaging, SCROLL_TABLE_CLASS } from "../listPaging";

export const metadata = { title: "Users & Permissions" };

/**
 * Main Admin → Users & Permissions (MAIN_ADMIN_WORKSPACE.md §5): every login on the installation with
 * the person behind it, their role and the projects they may enter — one place to see all four.
 * Roles themselves (Permission Modules) stay where they are; this links there.
 */
export default async function AdminUsersPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string; size?: string }> }) {
  const { allowed, can } = await requireAdminSection("users.view");
  const params = await searchParams;
  const { q = "" } = params;
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
  const total = await countAdminUsers(platformPrisma, q);
  const { page, size, skip } = readListPaging(params, total);
  const [users, canCreate, canPermissions, projectCount] = await Promise.all([
    listAdminUsers(platformPrisma, q, { skip, take: size }),
    can("users.create"),
    can("permissions.view"),
    platformPrisma.project.count({ where: { status: { not: "ARCHIVED" } } }),
  ]);
  const term = q.trim();
  const href = (next: { page?: number; size?: number }) => listHref("/admin/users", { q: term, page: next.page, size: next.size ?? size });

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
      <div className="mb-4">
        <SearchField name="q" defaultValue={q} placeholder="Search username, name or email" preserve={{ size: size === ADMIN_LIST_DEFAULT_SIZE ? undefined : String(size) }} width="w-72 max-w-full" />
      </div>
      <div className={`${LIST_SCROLL_BOX} rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xs),var(--highlight-top)]`}>
      <table className={SCROLL_TABLE_CLASS}>
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
          {users.length === 0 ? (
            <tr>
              <Td colSpan={5} className="py-8 text-center text-[13px] text-[color:var(--color-muted-foreground)]">
                {term ? `No user matches “${term}”. Check the spelling, or search by username, name or email.` : "There are no users yet."}
              </Td>
            </tr>
          ) : null}
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
    </div>
  );
}
