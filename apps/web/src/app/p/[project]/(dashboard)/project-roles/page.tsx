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
        description={`The roles of ${project.name}: which pages each opens here, Read or Full, and what its Dashboard shows. Another project's roles are its own.`}
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
                  The pages of this project a member may open — chosen module by module and sub-module by sub-module, each as Read (open and look) or Full (also change
                  things) — and which parts of the Dashboard they see. Members see only those pages in the sidebar, and every other page is refused. It applies in this
                  project only: the same person can hold a different role in another project.
                </p>
              </HelpSection>
              <HelpSection title="Fine-tune">
                <p>Full gives every action of its pages. Under Fine-tune you can hold one back — for example, edit clients but never delete them.</p>
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
