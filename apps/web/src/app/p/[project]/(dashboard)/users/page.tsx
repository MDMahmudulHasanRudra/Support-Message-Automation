import { prisma } from "@/server/db";
import Link from "@/components/ProjectLink";

import { requireSession } from "@/server/auth";
import { requirePermission } from "@/server/permissions";
import { Button, HelpButton, HelpSection, PageHeader } from "@/components/ui";
import { formatDateTime } from "@/lib/date";
import { isMainAdmin } from "@/server/projectContext";
import { PRIVILEGED_KEYS } from "@/server/privilegeGuard";
import { UsersTable, type UserRow } from "./UsersTable";

export default async function UsersPage() {
  const session = await requireSession();
  await requirePermission(session, "users.view");

  const [users, viewerIsMainAdmin, adminRoles] = await Promise.all([
    prisma.user.findMany({
      include: { permissionModule: { select: { name: true } } },
      orderBy: { createdAt: "asc" },
    }),
    isMainAdmin(session.userId),
    // Roles at Administrator level: any Main Admin or project-administration key (privilegeGuard).
    prisma.permissionModulePermission.findMany({ where: { permission: { key: { in: [...PRIVILEGED_KEYS] } } }, select: { permissionModuleId: true }, distinct: ["permissionModuleId"] }),
  ]);
  const administratorRoles = new Set(adminRoles.map((r) => r.permissionModuleId));

  const rows: UserRow[] = users.map((u) => ({
    id: u.id,
    username: u.username,
    name: u.name,
    email: u.email,
    permissionModuleName: u.permissionModule?.name ?? null,
    isActive: u.isActive,
    lastLoginAtLabel: u.lastLoginAt ? formatDateTime(u.lastLoginAt) : null,
    isCurrentUser: u.id === session.userId,
    isAdministrator: Boolean(u.permissionModuleId && administratorRoles.has(u.permissionModuleId)),
    // Only a Main Admin deletes, never an Administrator-level account, never themselves (deleteUser re-checks).
    canDelete: viewerIsMainAdmin && u.id !== session.userId && !(u.permissionModuleId && administratorRoles.has(u.permissionModuleId)),
  }));

  return (
    <div>
      <PageHeader
        title="App Users"
        description="Every login identity for this dashboard, and the Permission Module each one is assigned."
        actions={
          <>
            <HelpButton moduleTitle="App Users">
              <HelpSection title="What this is">
                <p>
                  Each App User is one login identity. Assign a Permission Module to control what
                  they can access — see the Permission Modules page. A user with no module
                  assigned can log in but cannot reach any permission-gated page.
                </p>
              </HelpSection>
              <HelpSection title="Deactivate vs. Delete">
                <p>
                  Deactivating blocks login and signs the user out of every device; reactivating
                  restores access instantly. Delete removes the login for good. Only a Main Admin
                  can delete, and an Administrator account can never be deleted (nor your own).
                  What a deleted user did stays in the records without their name, and the System
                  Log keeps who was deleted. A user with Google Sheets work history can only be
                  deactivated.
                </p>
              </HelpSection>
              <HelpSection title="Sessions">
                <p>
                  Open a user’s Sessions page to see every device currently logged in and to force
                  a logout — one device, or all of that user’s other devices at once.
                </p>
              </HelpSection>
            </HelpButton>
            <Link href="/users/new">
              <Button>Create App User</Button>
            </Link>
          </>
        }
      />
      <UsersTable users={rows} />
    </div>
  );
}
