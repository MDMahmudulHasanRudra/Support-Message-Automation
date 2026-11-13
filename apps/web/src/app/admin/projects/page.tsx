import NextLink from "next/link";
import { AlertTriangle, Bot, FolderKanban, MessagesSquare, Plus } from "lucide-react";
import { ButtonLink, EmptyState, PageHeader, StatTile } from "@/components/ui";
import { getProjectSummaries, requireMainAdminPage } from "@/server/mainAdmin";
import { ProjectCard } from "../ProjectCard";
import { getBranding } from "@/server/branding";

export const metadata = { title: "Projects" };

export default async function ProjectsPage({ searchParams }: { searchParams: Promise<{ archived?: string }> }) {
  const { session, canManage } = await requireMainAdminPage();
  const includeArchived = (await searchParams).archived === "1";
  const [projects, { productName }] = await Promise.all([getProjectSummaries(session.userId, { includeArchived }), getBranding()]);

  return (
    <div>
      <PageHeader
        title="Projects"
        description={`Each project is one business or team in ${productName}, with its own numbers, conversations, people and reports. Open one to work in it.`}
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

      {projects.length > 0 ? (
        <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile icon={FolderKanban} label="Projects" value={projects.length} hint={`${projects.filter((p) => p.status === "ACTIVE").length} active`} />
          <StatTile icon={MessagesSquare} label="Messages today" value={projects.reduce((n, p) => n + p.messagesToday, 0).toLocaleString()} hint="Across every project" />
          <StatTile icon={Bot} label="AI answers today" value={projects.reduce((n, p) => n + p.aiRepliesToday, 0).toLocaleString()} tone="accent" hint="Questions answered without a person" />
          <StatTile
            icon={AlertTriangle}
            label="Need attention"
            value={projects.filter((p) => p.attention.length > 0).length}
            tone={projects.some((p) => p.attention.length > 0) ? "warning" : "success"}
            hint={projects.some((p) => p.attention.length > 0) ? "See the yellow notes below" : "Everything is working"}
          />
        </div>
      ) : null}

      {projects.length === 0 ? (
        includeArchived ? (
          <EmptyState>No projects to show.</EmptyState>
        ) : (
          <div className="rounded-[var(--radius-xl)] border border-dashed border-[var(--color-border-strong)] px-6 py-12 text-center">
            <p className="text-[15px] font-semibold text-[color:var(--color-foreground)]">Create your first project</p>
            <p className="mx-auto mt-1 max-w-md text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
              Pick your business type and it comes ready with the right modules. Then connect your number and start answering customers.
            </p>
            {canManage ? (
              <div className="mt-4 flex justify-center">
                <ButtonLink href="/admin/projects/new" variant="primary">
                  <Plus className="size-4" aria-hidden />
                  Create project
                </ButtonLink>
              </div>
            ) : null}
          </div>
        )
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
