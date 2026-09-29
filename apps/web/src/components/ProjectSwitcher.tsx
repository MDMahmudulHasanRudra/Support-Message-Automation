"use client";

import NextLink from "next/link";
import { Check, ChevronsUpDown, LayoutGrid, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PROJECT_STATUS_LABELS, type ProjectStatusValue } from "@support-automation/shared";
import { Badge, BrandMark } from "@/components/ui";

export interface SwitcherProject {
  name: string;
  slug: string;
  status: ProjectStatusValue;
}

const STATUS_COLOR: Record<ProjectStatusValue, "green" | "blue" | "yellow" | "gray"> = {
  ACTIVE: "green",
  SETUP: "blue",
  SUSPENDED: "yellow",
  ARCHIVED: "gray",
};

export function ProjectStatusBadge({ status }: { status: ProjectStatusValue }) {
  return (
    <Badge color={STATUS_COLOR[status]} dot>
      {PROJECT_STATUS_LABELS[status]}
    </Badge>
  );
}

/**
 * "ISP Digital ▾" at the top of the sidebar (MULTI_PROJECT_PLAN.md §8).
 *
 * Lists EXACTLY the projects the server says this user may enter — the list is computed on the
 * server from ProjectAccess (every project for a Main Admin), never from what exists. It is a
 * convenience, not a boundary: typing another project's URL is refused on the server regardless.
 *
 * Switching goes to the other project's Overview, not the same page there: a record id in one
 * project means nothing in another, so "the same page" would usually be a 404.
 *
 * Plain `next/link`, not ProjectLink — these hrefs already name their project (or none).
 */
export function ProjectSwitcher({
  current,
  projects,
  canViewAdmin,
  canCreate,
  collapsed = false,
}: {
  /** Null inside the Main Admin Portal, which is not a project. */
  current: SwitcherProject | null;
  projects: SwitcherProject[];
  canViewAdmin: boolean;
  canCreate: boolean;
  collapsed?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const title = current?.name ?? "Main Admin";
  return (
    <div ref={rootRef} className="relative min-w-0 flex-1">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Current project: ${title}. Switch project`}
        title={collapsed ? title : undefined}
        className={`flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-[var(--radius-md)] py-1 text-left transition-colors duration-[var(--duration-fast)] hover:bg-[var(--color-neutral-bg)]/60 ${
          collapsed ? "justify-center" : "pr-1.5 pl-0.5"
        }`}
      >
        <BrandMark className="size-8 shrink-0" />
        {collapsed ? null : (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold leading-tight tracking-[-0.01em] text-[color:var(--color-foreground)]">
                {title}
              </span>
              <span className="block truncate text-[11px] text-[color:var(--color-muted-foreground)]">
                {current ? "Softify Assist project" : "Softify Assist"}
              </span>
            </span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-[color:var(--color-subtle-foreground)]" aria-hidden />
          </>
        )}
      </button>

      {open ? (
        <div
          role="menu"
          className="animate-scale-in absolute top-full left-0 z-[var(--z-floating)] mt-2 w-64 origin-top-left rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-1.5 shadow-[var(--shadow-lg)]"
        >
          <p className="px-2.5 pt-1.5 pb-1 text-[10px] font-semibold tracking-[0.06em] text-[color:var(--color-subtle-foreground)] uppercase">
            Switch project
          </p>
          {projects.length === 0 ? (
            <p className="px-2.5 py-2 text-[13px] text-[color:var(--color-muted-foreground)]">No projects you can enter.</p>
          ) : (
            projects.map((project) => {
              const isCurrent = project.slug === current?.slug;
              return (
                <NextLink
                  key={project.slug}
                  href={`/p/${project.slug}/overview`}
                  role="menuitem"
                  aria-current={isCurrent ? "true" : undefined}
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-2 rounded-[var(--radius-md)] px-2.5 py-1.5 text-[13px] text-[color:var(--color-foreground)] transition-colors duration-[var(--duration-fast)] hover:bg-[var(--color-neutral-bg)]"
                >
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    {isCurrent ? <Check className="size-3.5 text-[color:var(--color-accent)]" aria-hidden /> : null}
                  </span>
                  <span className={`min-w-0 flex-1 truncate ${isCurrent ? "font-medium" : ""}`}>{project.name}</span>
                  {project.status === "ACTIVE" ? null : <ProjectStatusBadge status={project.status} />}
                </NextLink>
              );
            })
          )}
          {canViewAdmin || canCreate ? <div className="my-1 border-t border-[var(--color-border)]" /> : null}
          {canViewAdmin ? (
            <NextLink
              href="/admin"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 rounded-[var(--radius-md)] px-2.5 py-1.5 text-[13px] text-[color:var(--color-muted-foreground)] transition-colors hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)]"
            >
              <LayoutGrid className="size-3.5" aria-hidden />
              Main Admin
            </NextLink>
          ) : null}
          {canCreate ? (
            <NextLink
              href="/admin/projects/new"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 rounded-[var(--radius-md)] px-2.5 py-1.5 text-[13px] text-[color:var(--color-muted-foreground)] transition-colors hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)]"
            >
              <Plus className="size-3.5" aria-hidden />
              Create project
            </NextLink>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
