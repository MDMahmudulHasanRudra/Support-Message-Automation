import Link from "@/components/ProjectLink";
import { ArrowUpRight } from "lucide-react";
import { REPORT_CATEGORIES } from "@support-automation/shared";
import { EmptyState, PageHeader, SearchField } from "@/components/ui";
import { requireSession } from "@/server/auth";
import { getGrantedPermissionKeys, getPageAccess } from "@/server/permissions";
import { reportPagesFor } from "../navigation";
import { canOpenPath } from "../projectSections";
import { activeDisabledFeatures } from "@/server/projectFeatures";

export const metadata = { title: "All Reports" };

/**
 * Every report in one place. Each card opens the report at its own address, so nothing that links
 * to a report directly — bookmarks, exports, the ⌘K palette — changed.
 *
 * Gated per card rather than as a page: the hub belongs to no single module, and each report still
 * checks its own permission when opened. A role that can open none of them is told so here instead
 * of being bounced; the sidebar already hides this page from such a role.
 *
 * Cards are grouped by category (packages/shared/src/reportCatalogue.ts) and each says the question
 * it answers and what it exports — so somebody looking for "who answers late" finds Response SLA
 * without knowing its name. A category with no report this role can open is not shown.
 */
export default async function AllReportsPage({ searchParams }: { searchParams: Promise<{ search?: string }> }) {
  const session = await requireSession();
  const granted = new Set(await getGrantedPermissionKeys(session));
  // A project role that selects pages lists only the reports it opens (PROJECT_ROLES.md).
  const pageAccess = await getPageAccess(session);
  const allowed = reportPagesFor(granted, await activeDisabledFeatures(), pageAccess ? (href) => canOpenPath(href, pageAccess) : undefined);
  const search = ((await searchParams).search ?? "").trim();
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const reports = allowed.filter((report) => {
    const text = `${report.label} ${report.question} ${report.description} ${report.category} ${report.module}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });

  return (
    <div>
      <PageHeader title="All reports" description="Pick a report to open it. Each one keeps its own filters and export." actions={allowed.length ? <SearchField placeholder="Find a report…" defaultValue={search} /> : undefined} />

      {allowed.length === 0 ? (
        <EmptyState>Your role cannot open any report. Ask an administrator for Support Activity or Team Management access.</EmptyState>
      ) : reports.length === 0 ? (
        <EmptyState>No report matches “{search}”. Try a word like late, missed or workload.</EmptyState>
      ) : (
        <div className="flex flex-col gap-6">
          {REPORT_CATEGORIES.map((category) => {
            const inCategory = reports.filter((report) => report.category === category);
            if (inCategory.length === 0) return null;
            return (
              <section key={category} aria-labelledby={`reports-${category}`}>
                <h2
                  id={`reports-${category}`}
                  className="mb-2.5 text-[15px] font-semibold tracking-[-0.01em] text-[color:var(--color-foreground)]"
                >
                  {category}
                </h2>
                <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-3">
                  {inCategory.map((report) => {
                    const Icon = report.icon;
                    return (
                      <Link
                        key={report.href}
                        href={report.href}
                        title={report.description}
                        className="group flex min-w-0 items-start gap-3 rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-xs),var(--highlight-top)] transition-[box-shadow,border-color] hover:border-[var(--color-border-strong)] hover:shadow-[var(--shadow-sm)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
                      >
                        <span className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-accent-bg)] text-[color:var(--color-accent-fg)]">
                          <Icon className="size-4.5" aria-hidden />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-start justify-between gap-2">
                            <span className="text-sm font-semibold text-[color:var(--color-foreground)]">{report.label}</span>
                            <ArrowUpRight className="mt-0.5 size-3.5 shrink-0 text-[color:var(--color-subtle-foreground)] transition-colors group-hover:text-[color:var(--color-foreground)]" aria-hidden />
                          </span>
                          <span className="mt-1 block text-[13px] leading-snug text-[color:var(--color-muted-foreground)]">{report.question}</span>
                          <span className="mt-1.5 block text-[11.5px] text-[color:var(--color-subtle-foreground)]">Export: {report.exports.join(", ")}</span>
                        </span>
                      </Link>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
