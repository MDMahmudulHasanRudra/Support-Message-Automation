import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { requirePermission } from "@/server/permissions";
import { PageHeader } from "@/components/ui";
import { createUser } from "@/server/actions/users";
import { UserForm } from "../UserForm";

export default async function NewUserPage() {
  const session = await requireSession();
  await requirePermission(session, "users.create");

  const permissionModules = await prisma.permissionModule.findMany({
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  return (
    <div>
      <PageHeader title="Create App User" />
      <UserForm action={createUser} permissionModules={permissionModules} mode="create" submitLabel="Create User" />
    </div>
  );
}
