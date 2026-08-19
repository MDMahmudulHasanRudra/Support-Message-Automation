import Link from "next/link";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { requirePermission } from "@/server/permissions";
import { Button, HelpButton, HelpSection, PageHeader } from "@/components/ui";
import { PermissionModulesTable, type PermissionModuleRow } from "./PermissionModulesTable";

export default async function PermissionModulesPage() {
  const session = await requireSession();
  await requirePermission(session, "permissions.view");

  const modules = await prisma.permissionModule.findMany({
    include: { _count: { select: { users: true, permissions: true } } },
    orderBy: { createdAt: "asc" },
  });

  const rows: PermissionModuleRow[] = modules.map((m) => ({
    id: m.id,
    name: m.name,
    description: m.description,
    userCount: m._count.users,
    permissionCount: m._count.permissions,
    isSystem: m.isSystem,
  }));

  return (
    <div>
      <PageHeader
        title="Permission Modules"
        description="Reusable permission profiles. Assign one to each App User on the Users page."
        actions={
          <>
            <HelpButton moduleTitle="Permission Modules">
              <HelpSection title="What this is">
                <p>
                  A Permission Module is a named set of permissions — Administrator, Support
                  Manager, Support Agent, and Read Only exist by default and cannot be renamed or
                  deleted, but their permissions can still be adjusted. Create a custom module for
                  any other combination you need; the same module can be assigned to many users.
                </p>
              </HelpSection>
              <HelpSection title="Deleting a module">
                <p>
                  Blocked while any App User is still assigned to it — reassign those users first.
                  This is enforced by the database itself, not just this page.
                </p>
              </HelpSection>
            </HelpButton>
            <Link href="/permissions/new">
              <Button>Create Permission Module</Button>
            </Link>
          </>
        }
      />
      <PermissionModulesTable modules={rows} />
    </div>
  );
}
