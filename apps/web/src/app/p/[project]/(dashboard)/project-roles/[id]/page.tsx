import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { requireAccess } from "@/server/authorize";
import { updateProjectRole } from "@/server/actions/projectAdmin";
import { getProjectRole } from "@/server/projectAdmin";
import { ProjectRoleForm } from "../ProjectRoleForm";
import { sectionAccessFromKeys, writeKeysOf } from "../../projectSections";

export const metadata = { title: "Edit Project Role" };

export default async function EditProjectRolePage({ params }: { params: Promise<{ id: string }> }) {
  await requireAccess("project_roles.manage");
  const { id } = await params;
  // The scoped client: another project's role is simply not found here.
  const role = await getProjectRole(id);
  if (!role) notFound();
  // A role saved before pages could be chosen starts from the pages its keys opened; nothing changes until saved.
  const legacy = role.sectionAccess === null;
  const sectionAccess = role.sectionAccess ?? sectionAccessFromKeys(role.permissionKeys);
  // A write key a Full page would give that the role does not hold was held back under "Fine-tune".
  const excludedKeys = writeKeysOf(sectionAccess).filter((key) => !role.permissionKeys.includes(key));
  return (
    <div className="space-y-4">
      <PageHeader
        title={`Edit "${role.name}"`}
        description={`${role.memberCount} member${role.memberCount === 1 ? "" : "s"} hold this role; a change applies to them on their next click.`}
      />
      <ProjectRoleForm
        action={updateProjectRole.bind(null, role.id)}
        defaults={{ name: role.name, description: role.description, sectionAccess, excludedKeys }}
        submitLabel="Save role"
        legacy={legacy}
      />
    </div>
  );
}
