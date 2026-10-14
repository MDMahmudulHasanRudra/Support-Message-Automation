import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { requireAccess } from "@/server/authorize";
import { updateProjectRole } from "@/server/actions/projectAdmin";
import { getProjectRole } from "@/server/projectAdmin";
import { ProjectRoleForm } from "../ProjectRoleForm";

export const metadata = { title: "Edit Project Role" };

export default async function EditProjectRolePage({ params }: { params: Promise<{ id: string }> }) {
  await requireAccess("project_roles.manage");
  const { id } = await params;
  // The scoped client: another project's role is simply not found here.
  const role = await getProjectRole(id);
  if (!role) notFound();
  return (
    <div className="space-y-4">
      <PageHeader
        title={`Edit "${role.name}"`}
        description={`${role.memberCount} member${role.memberCount === 1 ? "" : "s"} hold this role; a change applies to them on their next click.`}
      />
      <ProjectRoleForm
        action={updateProjectRole.bind(null, role.id)}
        defaults={{ name: role.name, description: role.description, permissionKeys: role.permissionKeys }}
        submitLabel="Save role"
      />
    </div>
  );
}
