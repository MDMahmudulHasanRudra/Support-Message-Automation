import NextLink from "next/link";
import { redirect } from "next/navigation";
import { FolderKanban } from "lucide-react";
import { Alert, EmptyState, PageHeader } from "@/components/ui";
import { ProjectStatusBadge } from "@/components/ProjectSwitcher";
import { requireMainAdminPage } from "@/server/mainAdmin";
import { chooseWorkspaceProject, workspaceProjects } from "@/server/workspace";
import { safeWorkspaceTarget, workspaceHref } from "@/lib/workspace";
import { resolveNavLocation } from "@/app/p/[project]/(dashboard)/navigation";

export const metadata = { title: "Workspace" };

/**
 * `/admin/workspace?to=/messages` opens a project page in the workspace, choosing the project on the
 * server (the remembered one if the page can open there, otherwise the first that can). The cookie
 * only picks a tab; a project the viewer can no longer use is simply not a candidate, so it is never
 * reopened.
 *
 * `?unavailable=1` is where a workspace page sends someone whose project is no longer theirs — a
 * stale tab after access was removed, a project archived, a slug typed by hand. It does not say which.
 */
export default async function WorkspaceOpen({ searchParams }: { searchParams: Promise<{ to?: string; unavailable?: string }> }) {
  const { session } = await requireMainAdminPage();
  const params = await searchParams;
  const to = safeWorkspaceTarget(params.to);
  const label = resolveNavLocation(to.split("?")[0]!, new URLSearchParams(to.split("?")[1] ?? ""))?.label ?? "This page";

  if (!params.unavailable) {
    const project = await chooseWorkspaceProject(session, to);
    if (project) redirect(workspaceHref(to, project.slug));
  }

  const projects = await workspaceProjects(session);
  return (
    <div>
      <PageHeader title="Workspace" description="Every project module, with the projects you can use it in as tabs." />
      {params.unavailable ? (
        <div className="mb-6">
          <Alert tone="warning" title="That project is not available here">
            It may not exist, you may no longer have access to it, or it may have been archived.
          </Alert>
        </div>
      ) : (
        <div className="mb-6">
          <Alert tone="info" title={`${label} is not available in any of your projects`}>
            Your role may not include it, or it is switched off in every project you can enter. A Main Admin can change either
            from Projects.
          </Alert>
        </div>
      )}
      {projects.length === 0 ? (
        <EmptyState icon={<FolderKanban className="size-5" aria-hidden />}>You do not have access to any project yet.</EmptyState>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <li key={project.slug}>
              <NextLink
                href={workspaceHref("/overview", project.slug)}
                className="flex items-center justify-between gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-[13px] font-medium text-[color:var(--color-foreground)] transition-colors duration-[var(--duration-fast)] hover:bg-[var(--color-neutral-bg)]"
              >
                <span className="truncate">{project.name}</span>
                <ProjectStatusBadge status={project.status} />
              </NextLink>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
