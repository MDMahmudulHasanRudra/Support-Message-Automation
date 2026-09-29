import NextLink from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { FolderKanban } from "lucide-react";
import { Alert, EmptyState, PageHeader } from "@/components/ui";
import { ProjectStatusBadge } from "@/components/ProjectSwitcher";
import { requireMainAdminPage } from "@/server/mainAdmin";
import { workspaceTabs } from "@/server/workspace";
import { WORKSPACE_PROJECT_COOKIE, workspaceModule, workspacePath } from "@/lib/workspace";

/**
 * `/admin/workspace/<module>`: opens the module in a project. The project last opened in the
 * workspace if it is still one of the viewer's tabs, otherwise the first tab. The cookie only picks
 * which tab to open; a project that is no longer a tab — access removed, module switched off,
 * project archived — is simply not among them, so it is never reopened.
 *
 * With no tab to open it says why, in terms the viewer can act on.
 */
export async function WorkspaceModuleStart({ moduleKey, unavailable }: { moduleKey: string; unavailable: boolean }) {
  const mod = workspaceModule(moduleKey);
  if (!mod) notFound();
  const { session } = await requireMainAdminPage();
  const result = await workspaceTabs(session, mod);

  if (result.ok && result.tabs.length > 0 && !unavailable) {
    const remembered = (await cookies()).get(WORKSPACE_PROJECT_COOKIE)?.value;
    const target = result.tabs.find((tab) => tab.slug === remembered) ?? result.tabs[0]!;
    redirect(workspacePath(mod.key, target.slug));
  }

  return (
    <div>
      <PageHeader title={mod.label} description={mod.description} />
      {unavailable ? (
        <div className="mb-6">
          <Alert tone="warning" title="That project is not available here">
            It may not exist, you may not have access to it, or {mod.label} may be switched off for it.
          </Alert>
        </div>
      ) : null}
      {!result.ok ? (
        <EmptyState icon={<FolderKanban className="size-5" aria-hidden />}>
          Your role does not include {mod.label}. An administrator can add it to your role on Permission Modules.
        </EmptyState>
      ) : result.tabs.length === 0 ? (
        <EmptyState icon={<FolderKanban className="size-5" aria-hidden />}>
          None of the projects you can enter has {mod.label} switched on. A Main Admin can give you access to a project, or
          switch the module on, from Projects.
        </EmptyState>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {result.tabs.map((tab) => (
            <li key={tab.slug}>
              <NextLink
                href={workspacePath(mod.key, tab.slug)}
                className="flex items-center justify-between gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-[13px] font-medium text-[color:var(--color-foreground)] transition-colors duration-[var(--duration-fast)] hover:border-[var(--color-accent)]"
              >
                <span className="truncate">{tab.name}</span>
                <ProjectStatusBadge status={tab.status} />
              </NextLink>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
