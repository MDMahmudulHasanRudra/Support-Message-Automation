import { notFound } from "next/navigation";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { requirePermission } from "@/server/permissions";
import { PageHeader } from "@/components/ui";
import { updateUser } from "@/server/actions/users";
import { UserForm, type UserFormDefaults } from "../../UserForm";

export default async function EditUserPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  await requirePermission(session, "users.edit");

  const { id } = await params;
  const [user, permissionModules] = await Promise.all([
    prisma.user.findUnique({ where: { id } }),
    prisma.permissionModule.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  if (!user) notFound();

  const defaults: UserFormDefaults = {
    username: user.username,
    name: user.name,
    email: user.email ?? undefined,
    permissionModuleId: user.permissionModuleId ?? undefined,
  };

  return (
    <div>
      <PageHeader title={`Edit App User: ${user.username}`} />
      <UserForm
        action={updateUser.bind(null, user.id)}
        defaults={defaults}
        permissionModules={permissionModules}
        mode="edit"
        submitLabel="Save Changes"
      />
    </div>
  );
}
