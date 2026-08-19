import { notFound } from "next/navigation";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { requirePermission } from "@/server/permissions";
import { PageHeader } from "@/components/ui";
import { updatePermissionModule } from "@/server/actions/permissionModules";
import { PermissionModuleForm, type PermissionModuleFormDefaults } from "../../PermissionModuleForm";

export default async function EditPermissionModulePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  await requirePermission(session, "permissions.edit");

  const { id } = await params;
  const module_ = await prisma.permissionModule.findUnique({
    where: { id },
    include: { permissions: { select: { permission: { select: { key: true } } } } },
  });
  if (!module_) notFound();

  const defaults: PermissionModuleFormDefaults = {
    name: module_.name,
    description: module_.description ?? undefined,
    permissionKeys: module_.permissions.map((p) => p.permission.key),
    isSystem: module_.isSystem,
  };

  return (
    <div>
      <PageHeader title={`Edit Permission Module: ${module_.name}`} />
      <PermissionModuleForm action={updatePermissionModule.bind(null, module_.id)} defaults={defaults} submitLabel="Save Changes" />
    </div>
  );
}
