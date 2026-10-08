import NextLink from "next/link";
import { Plus } from "lucide-react";
import { ButtonLink, EmptyState, PageHeader } from "@/components/ui";
import { getProjectSummaries, requireMainAdminPage } from "@/server/mainAdmin";
import { ProjectCard } from "../ProjectCard";

export const metadata = { title: "Projects" };

export default async function ProjectsPage({ searchParams }: { searchParams: Promise<{ archived?: string }> }) {
  const { session, canManage } = await requireMainAdminPage();
  const includeArchived = (await searchParams).archived === "1";
  const projects = await getProjectSummaries(session.userId, { includeArchived });

  return (
    <div>
      <PageHeader
        title="Projects"
        description="Each project is its own Softify Assist: its own WhatsApp numbers, groups, rules, AI, knowledge, team and reports. Opening one takes you into the portal you already know, with the permissions your role already has."
        actions={
          <>
            <NextLink
              href={includeArchived ? "/admin/projects" : "/admin/projects?archived=1"}
              className="text-[13px] font-medium text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
            >
              {includeArchived ? "Hide archived" : "Show archived"}
            </NextLink>
            {canManage ? (
              <ButtonLink href="/admin/projects/new" variant="primary">
                <Plus className="size-4" aria-hidden />
                Create project
              </ButtonLink>
            ) : null}
          </>
        }
      />

      {projects.length === 0 ? (
        <EmptyState>No projects to show.</EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {projects.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
          {canManage ? (
            <NextLink
              href="/admin/projects/new"
              className="flex min-h-48 flex-col items-center justify-center gap-2 rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border-strong)] text-[13px] font-medium text-[color:var(--color-muted-foreground)] transition-colors hover:border-[var(--color-accent)] hover:text-[color:var(--color-accent)]"
            >
              <Plus className="size-5" aria-hidden />
              Create new project
            </NextLink>
          ) : null}
        </div>
      )}
    </div>
  );
}
