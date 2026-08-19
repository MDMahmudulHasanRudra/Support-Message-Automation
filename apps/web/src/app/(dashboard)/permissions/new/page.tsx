import { requireSession } from "@/server/auth";
import { requirePermission } from "@/server/permissions";
import { PageHeader } from "@/components/ui";
import { createPermissionModule } from "@/server/actions/permissionModules";
import { PermissionModuleForm } from "../PermissionModuleForm";

export default async function NewPermissionModulePage() {
  const session = await requireSession();
  await requirePermission(session, "permissions.create");

  return (
    <div>
      <PageHeader title="Create Permission Module" />
      <PermissionModuleForm action={createPermissionModule} submitLabel="Create Module" />
    </div>
  );
}
