import type { ReactNode } from "react";
import Link from "@/components/ProjectLink";
import { ArrowUpRight } from "lucide-react";
import { pathAllowedByFeatures } from "@support-automation/shared";
import { Badge, EmptyState, PageHeader } from "@/components/ui";
import { activeDisabledFeatures } from "@/server/projectFeatures";
import { openableSections, type SectionAccess } from "../projectSections";

/**
 * The Overview of a member whose project role shows no part of the Dashboard (PROJECT_ROLES.md): the
 * pages their role opens, by module, each marked Read or Full — a landing page with somewhere to go
 * rather than an empty dashboard.
 */
export async function YourPages({ access, notices }: { access: SectionAccess; notices: ReactNode }) {
  const featuresOff = await activeDisabledFeatures();
  const pages = openableSections(access).filter(({ section }) => pathAllowedByFeatures(section.id, featuresOff));
  const modules: Array<[string, typeof pages]> = [];
  for (const entry of pages) {
    const last = modules[modules.length - 1];
    if (last && last[0] === entry.module) last[1].push(entry);
    else modules.push([entry.module, [entry]]);
  }

  return (
    <div>
      <PageHeader title="Your pages" description="The pages your role opens in this project. The project's Lead decides which, and whether you can change things there." />
      {notices}
      {modules.length === 0 ? (
        <EmptyState>Your role in this project does not open any page yet. Ask the project&apos;s Lead to add the pages you need.</EmptyState>
      ) : (
        <div className="flex flex-col gap-8">
          {modules.map(([module, entries]) => (
            <section key={module} aria-labelledby={`your-pages-${module}`}>
              <h2
                id={`your-pages-${module}`}
                className="mb-3 text-[12px] font-semibold tracking-[0.06em] text-[color:var(--color-muted-foreground)] uppercase"
              >
                {module}
              </h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {entries.map(({ section }) => (
                  <Link
                    key={section.id}
                    href={section.id}
                    className="group flex items-center justify-between gap-3 rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3.5 shadow-[var(--shadow-xs),var(--highlight-top)] transition-[box-shadow,border-color] duration-[var(--duration-base)] ease-[var(--ease-out)] hover:border-[var(--color-border-strong)] hover:shadow-[var(--shadow-sm)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
                  >
                    <span className="min-w-0 truncate text-[14px] font-medium text-[color:var(--color-foreground)]">{section.label}</span>
                    <span className="flex shrink-0 items-center gap-2">
                      <Badge color={access[section.id] === "FULL" ? "green" : "gray"}>{access[section.id] === "FULL" ? "Full" : "Read"}</Badge>
                      <ArrowUpRight
                        className="size-4 text-[color:var(--color-subtle-foreground)] transition-colors group-hover:text-[color:var(--color-foreground)]"
                        aria-hidden
                      />
                    </span>
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
