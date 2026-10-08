"use client";

import NextLink from "next/link";
import { ExternalLink, Globe } from "lucide-react";
import { ProjectStatusBadge } from "@/components/ProjectSwitcher";
import { isGlobalPage, workspaceHref, workspaceTabsFor, type WorkspaceProject } from "@/lib/workspace";
import { resolveNavLocation } from "./navigation";

/**
 * The project tabs of the Main Admin Workspace — ONE component for every module
 * (MAIN_ADMIN_WORKSPACE.md §3). Drawn above whichever project page is open; the page itself is the
 * project portal's own.
 *
 * A tab opens the SAME section in the other project: the nav entry this page belongs to, not this
 * exact URL, because a detail page's id (`/chat/<groupId>`, `/rules/<id>/edit`) belongs to one
 * project and means nothing in another. Which tabs exist is `workspaceTabsFor`: the projects the
 * viewer may enter (server-computed) with this page's feature on. A tab is presentation — opening
 * it runs every check again, in that project.
 */
export function WorkspaceTabs({
  projects,
  current,
  pathname,
  search,
}: {
  projects: WorkspaceProject[];
  current: WorkspaceProject;
  pathname: string;
  search: URLSearchParams;
}) {
  const queryString = search.toString();
  const openInProject = `/p/${current.slug}${pathname === "/" ? "" : pathname}${queryString ? `?${queryString}` : ""}`;

  if (isGlobalPage(pathname)) {
    return (
      <div className="mb-4 flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--color-border)] pb-2 text-xs text-[color:var(--color-muted-foreground)]">
        <Globe className="size-3.5 shrink-0" aria-hidden />
        <span className="flex-1">The same in every project — this page has no project tabs.</span>
      </div>
    );
  }

  const tabs = workspaceTabsFor(projects, pathname);
  const section = resolveNavLocation(pathname, search)?.href.split("?")[0] ?? "/overview";

  return (
    <div className="mb-4 flex h-10 items-end gap-3 border-b border-[var(--color-border)]">
      <nav aria-label="Projects" className="-mb-px flex min-w-0 flex-1 gap-1 overflow-x-auto">
        {tabs.map((tab) => {
          const active = tab.slug === current.slug;
          return (
            <NextLink
              key={tab.slug}
              href={workspaceHref(section, tab.slug)}
              aria-current={active ? "page" : undefined}
              data-project-tab={tab.slug}
              className={`relative flex shrink-0 items-center gap-2 px-3 pt-1.5 pb-2.5 text-[13px] whitespace-nowrap transition-colors duration-[var(--duration-fast)] ${
                active
                  ? "font-medium text-[color:var(--color-foreground)]"
                  : "text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
              }`}
            >
              {/* The active tab's underline, as a filled bar inside the tab. */}
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
        href={openInProject}
        data-open-in-project
        className="mb-2 hidden shrink-0 items-center gap-1.5 text-xs text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)] hover:underline sm:inline-flex"
      >
        Open in {current.name}
        <ExternalLink className="size-3.5" aria-hidden />
      </NextLink>
    </div>
  );
}
