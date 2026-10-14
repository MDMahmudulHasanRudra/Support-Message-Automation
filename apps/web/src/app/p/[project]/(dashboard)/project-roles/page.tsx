import Link from "@/components/ProjectLink";
import { Button, HelpButton, HelpSection, PageHeader } from "@/components/ui";
import { requireAccess } from "@/server/authorize";
import { requireActiveProject } from "@/server/projectContext";
import { listProjectRoles } from "@/server/projectAdmin";
import { ProjectRolesTable } from "./ProjectRolesTable";

export const metadata = { title: "Project Roles" };

/** This project's own roles (PROJECT_ROLES.md), run by its Lead or a Main Admin. */
export default async function ProjectRolesPage() {
  await requireAccess("project_roles.manage");
  const project = await requireActiveProject();
  const roles = await listProjectRoles();
  return (
    <div className="space-y-6">
      <PageHeader
        title="Project Roles"
        description={`The roles of ${project.name}: which modules each opens here, read or write. Another project's roles are its own.`}
        actions={
          <>
            <Link href="/project-members">
              <Button variant="secondary">Project Members</Button>
            </Link>
            <Link href="/project-roles/new">
              <Button>New project role</Button>
            </Link>
            <HelpButton moduleTitle="Project Roles">
              <HelpSection title="What a project role is">
                <p>
                  A set of modules — each as Read (open and look) or Write (change) — that you give members of this project. It applies in this project only: the same person can
                  hold a different role in another project.
                </p>
              </HelpSection>
              <HelpSection title="What it can never include">
                <p>The Main Admin Portal, the platform&apos;s App Users and Permission Modules, and running this project&apos;s members and roles. Those stay with Main Admins and the Lead.</p>
              </HelpSection>
              <HelpSection title="Modules switched off">
                <p>A module the Main Admin has switched off for this project stays off for everybody, whatever a role says.</p>
              </HelpSection>
            </HelpButton>
          </>
        }
      />
      <ProjectRolesTable roles={roles} />
    </div>
  );
}
