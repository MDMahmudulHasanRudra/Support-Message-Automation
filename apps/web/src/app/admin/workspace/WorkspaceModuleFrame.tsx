import NextLink from "next/link";
import { notFound, redirect } from "next/navigation";
import { ExternalLink } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { ProjectStatusBadge } from "@/components/ProjectSwitcher";
import { requireSession } from "@/server/auth";
import { requireProjectPage } from "@/server/authorize";
import { workspaceTabs } from "@/server/workspace";
import { WORKSPACE_BASE, workspaceModule, workspacePath } from "@/lib/workspace";

/**
 * One workspace module in one project: the project tabs, then the module's EXISTING layout and pages
 * (MAIN_ADMIN_WORKSPACE.md §3). Rendered by each module's `[project]/layout.tsx`.
 *
 * Two checks, in this order:
 *   1. The slug must be one of the viewer's tabs for this module. Otherwise — a project that does
 *      not exist, one they cannot enter, one with the module switched off, or a tab left open after
 *      access was removed — they go back to the module's start page, which says the project is not
 *      available without saying which of those it was.
 *   2. `requireProjectPage()`, the project portal's own gate, decides again from the URL the server
 *      received. The tabs are presentation; this is the check. The module's pages then make their
 *      own permission checks, exactly as they do in the portal.
 */
export async function WorkspaceModuleFrame({ moduleKey, slug, children }: { moduleKey: string; slug: string; children: ReactNode }) {
  const mod = workspaceModule(moduleKey);
  if (!mod) notFound();
  const session = await requireSession();
  const result = await workspaceTabs(session, mod);
  const tabs = result.ok ? result.tabs : [];
  if (!tabs.some((tab) => tab.slug === slug)) redirect(`${WORKSPACE_BASE}/${mod.key}?unavailable=1`);

  const project = await requireProjectPage();
  // proxy.ts takes the project from this same URL segment, so the two cannot differ; refuse if they ever do.
  if (project.slug !== slug) notFound();

  return (
    // Room for the tab row above the module's full-height frame (see the chat layout's --chat-inset).
    <div style={{ "--chat-inset": "10rem", "--chat-inset-sm": "11.5rem" } as CSSProperties}>
      <div className="mb-3 flex h-10 items-end gap-3 border-b border-[var(--color-border)]">
        <nav aria-label={`${mod.label} projects`} className="-mb-px flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {tabs.map((tab) => {
            const active = tab.slug === slug;
            return (
              <NextLink
                key={tab.slug}
                href={workspacePath(mod.key, tab.slug)}
                aria-current={active ? "page" : undefined}
                className={`relative flex shrink-0 items-center gap-2 px-3 pt-1.5 pb-2.5 text-[13px] whitespace-nowrap transition-colors duration-[var(--duration-fast)] ${
                  active
                    ? "font-medium text-[color:var(--color-foreground)]"
                    : "text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
                }`}
              >
                {/* A filled bar rather than a coloured border: globals.css sets every element's
                    border-color outside a layer, which outranks a border-colour utility. */}
                <span
                  aria-hidden
                  className={`absolute inset-x-0 bottom-0 h-[2px] rounded-full transition-colors duration-[var(--duration-fast)] ${
                    active ? "bg-[var(--color-accent)]" : "bg-transparent"
                  }`}
                />
                {tab.name}
                {tab.status !== "ACTIVE" ? <ProjectStatusBadge status={tab.status} /> : null}
              </NextLink>
            );
          })}
        </nav>
        <NextLink
          href={`/p/${project.slug}${mod.projectPath}`}
          className="mb-2 hidden shrink-0 items-center gap-1.5 text-xs text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)] hover:underline sm:inline-flex"
        >
          Open in {project.name}
          <ExternalLink className="size-3.5" aria-hidden />
        </NextLink>
      </div>
      {children}
    </div>
  );
}
