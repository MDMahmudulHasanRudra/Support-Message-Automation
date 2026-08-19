import Link from "next/link";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { requirePermission } from "@/server/permissions";
import { Button, HelpButton, HelpSection, PageHeader } from "@/components/ui";
import { formatDateTime } from "@/lib/date";
import { UsersTable, type UserRow } from "./UsersTable";

export default async function UsersPage() {
  const session = await requireSession();
  await requirePermission(session, "users.view");

  const users = await prisma.user.findMany({
    include: { permissionModule: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });

  const rows: UserRow[] = users.map((u) => ({
    id: u.id,
    username: u.username,
    name: u.name,
    email: u.email,
    permissionModuleName: u.permissionModule?.name ?? null,
    isActive: u.isActive,
    lastLoginAtLabel: u.lastLoginAt ? formatDateTime(u.lastLoginAt) : null,
    isCurrentUser: u.id === session.userId,
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
                  There is no delete — deactivating blocks login and immediately signs the user
                  out of every device, while preserving their history (rules they created,
                  messages they resolved, etc). Reactivating restores access instantly.
                </p>
              </HelpSection>
              <HelpSection title="Sessions">
                <p>
                  Open a user's Sessions page to see every device currently logged in and to force
                  a logout — one device, or all of that user's other devices at once.
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
