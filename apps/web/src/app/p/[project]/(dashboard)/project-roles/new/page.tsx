import { PageHeader } from "@/components/ui";
import { requireAccess } from "@/server/authorize";
import { createProjectRole } from "@/server/actions/projectAdmin";
import { ProjectRoleForm } from "../ProjectRoleForm";

export const metadata = { title: "New Project Role" };

export default async function NewProjectRolePage() {
  await requireAccess("project_roles.manage");
  return (
    <div className="space-y-4">
      <PageHeader title="New project role" description="Choose the modules this role opens in this project, and for each whether members may only read or also write." />
      <ProjectRoleForm action={createProjectRole} submitLabel="Create role" />
    </div>
  );
}
