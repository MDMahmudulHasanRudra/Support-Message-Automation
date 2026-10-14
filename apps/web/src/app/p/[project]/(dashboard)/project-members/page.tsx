import Link from "@/components/ProjectLink";
import { Alert, Button, Card, HelpButton, HelpSection, PageHeader, SectionHeader } from "@/components/ui";
import { requireAccess } from "@/server/authorize";
import { hasPermission } from "@/server/permissions";
import { requireActiveProject } from "@/server/projectContext";
import { listProjectMembers, listProjectRoles } from "@/server/projectAdmin";
import { formatDateTime } from "@/lib/date";
import { createProjectMember } from "@/server/actions/projectAdmin";
import { AddProjectMemberForm, ProjectMembersTable, type MemberRow } from "./ProjectMembersClient";

export const metadata = { title: "Project Members" };

/**
 * A project's members, run by its Lead or a Main Admin (PROJECT_ROLES.md). Everyone who may enter THIS
 * project, their project role here, and the logins created for this project. Nothing from another
 * project is listed, and nothing here changes another project.
 */
export default async function ProjectMembersPage({ searchParams }: { searchParams: Promise<{ created?: string }> }) {
  const session = await requireAccess("project_members.manage");
  const project = await requireActiveProject();
  const { created } = await searchParams;
  const [members, roles, canManageRoles] = await Promise.all([
    listProjectMembers(project.id, session.userId),
    listProjectRoles(),
    hasPermission(session, "project_roles.manage"),
  ]);

  const rows: MemberRow[] = members.map((m) => ({
    userId: m.userId,
    username: m.username,
    name: m.name,
    email: m.email,
    isActive: m.isActive,
    lastLoginLabel: m.lastLoginAt ? formatDateTime(m.lastLoginAt) : null,
    isLead: m.isLead,
    isMainAdmin: m.isMainAdmin,
    level: m.level,
    projectRoleId: m.projectRole?.id ?? null,
    globalRoleName: m.globalRoleName,
    otherProjects: m.otherProjects,
    isSelf: m.isSelf,
    can: m.can,
  }));
  const roleOptions = roles.map((r) => ({ id: r.id, name: r.name }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Project Members"
        description={`Everyone who can enter ${project.name}, and what each may do here. Changes here never reach another project.`}
        actions={
          <>
          {canManageRoles ? (
            <Link href="/project-roles">
              <Button variant="secondary">Project Roles</Button>
            </Link>
          ) : null}
          <HelpButton moduleTitle="Project Members">
            <HelpSection title="Who is listed">
              <p>Every login that may enter this project. A member&apos;s project role decides which modules they may open here and whether they may only view or also change things.</p>
            </HelpSection>
            <HelpSection title="Lead">
              <p>
                The Lead runs this project: they create its app users and project roles. Only a Main Admin makes someone a Lead, and only a Main Admin can change a Lead or another
                administrator here.
              </p>
            </HelpSection>
            <HelpSection title="Logins shared with other projects">
              <p>
                A member who can also enter another project, or who has a platform role, keeps one login everywhere. Here you can change their role in this project or remove them from
                it; their password and whether the login is active are a Main Admin&apos;s to change.
              </p>
            </HelpSection>
            <HelpSection title="Passwords">
              <p>Passwords are stored only as a one-way hash, so nobody — not a Lead, not a Main Admin — can read one. Reset it instead; that signs the member out everywhere.</p>
            </HelpSection>
          </HelpButton>
          </>
        }
      />
      {created ? <Alert tone="success">Member created. They can sign in now and will land in this project.</Alert> : null}

      <Card>
        <SectionHeader title="Add a member" description="Creates a new login for this project only, with the project role you choose." />
        {roleOptions.length === 0 ? (
          <Alert tone="warning" title="Create a project role first">
            A member needs a project role.{" "}
            {canManageRoles ? (
              <Link href="/project-roles/new" className="underline">
                Create one now
              </Link>
            ) : (
              "Ask the project's Lead to create one."
            )}
          </Alert>
        ) : (
          <AddProjectMemberForm action={createProjectMember} roles={roleOptions} />
        )}
      </Card>

      <Card>
        <SectionHeader title={`Members (${rows.length})`} description="Project role here, access level, and the logins you may manage." />
        <ProjectMembersTable rows={rows} roles={roleOptions} />
      </Card>
    </div>
  );
}
