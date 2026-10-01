import Link from "@/components/ProjectLink";
import { ArrowUpRight } from "lucide-react";
import { REPORT_CATEGORIES } from "@support-automation/shared";
import { EmptyState, PageHeader } from "@/components/ui";
import { requireSession } from "@/server/auth";
import { getGrantedPermissionKeys } from "@/server/permissions";
import { reportPagesFor } from "../navigation";
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
export default async function AllReportsPage() {
  const session = await requireSession();
  const granted = new Set(await getGrantedPermissionKeys(session));
  const reports = reportPagesFor(granted, await activeDisabledFeatures());

  return (
    <div>
      <PageHeader title="All reports" description="Pick a report to open it. Each one keeps its own filters and export." />

      {reports.length === 0 ? (
        <EmptyState>Your role cannot open any report. Ask an administrator for Support Activity or Team Management access.</EmptyState>
      ) : (
        <div className="flex flex-col gap-8">
          {REPORT_CATEGORIES.map((category) => {
            const inCategory = reports.filter((report) => report.category === category);
            if (inCategory.length === 0) return null;
            return (
              <section key={category} aria-labelledby={`reports-${category}`}>
                <h2
                  id={`reports-${category}`}
                  className="mb-3 text-[12px] font-semibold tracking-[0.06em] text-[color:var(--color-muted-foreground)] uppercase"
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
                        className="group flex flex-col rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-[var(--shadow-xs),var(--highlight-top)] transition-[box-shadow,border-color] duration-[var(--duration-base)] ease-[var(--ease-out)] hover:border-[var(--color-border-strong)] hover:shadow-[var(--shadow-sm)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <span className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-lg)] bg-[var(--color-neutral-bg)] text-[color:var(--color-accent)]">
                            <Icon className="size-4.5" aria-hidden />
                          </span>
                          <ArrowUpRight
                            className="size-4 text-[color:var(--color-subtle-foreground)] transition-colors group-hover:text-[color:var(--color-foreground)]"
                            aria-hidden
                          />
                        </div>
                        <p className="mt-4 text-[11px] font-medium uppercase tracking-[0.06em] text-[color:var(--color-subtle-foreground)]">
                          {report.module}
                        </p>
                        <h3 className="mt-1 text-[15px] font-semibold tracking-[-0.01em] text-[color:var(--color-foreground)]">
                          {report.label}
                        </h3>
                        <p className="mt-1.5 text-[13px] font-medium leading-relaxed text-[color:var(--color-foreground)]">{report.question}</p>
                        <p className="mt-1 text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">{report.description}</p>
                        <div className="mt-auto flex items-center justify-between gap-2 pt-4 text-[12px]">
                          <span className="text-[color:var(--color-subtle-foreground)]">Export: {report.exports.join(", ")}</span>
                          <span className="font-medium text-[color:var(--color-accent)] group-hover:underline">Open report</span>
                        </div>
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
