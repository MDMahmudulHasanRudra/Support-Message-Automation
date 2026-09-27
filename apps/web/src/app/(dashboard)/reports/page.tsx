import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/ui";
import { requireSession } from "@/server/auth";
import { getGrantedPermissionKeys } from "@/server/permissions";
import { reportPagesFor } from "../navigation";

export const metadata = { title: "All Reports" };

/**
 * Every report in one place. Each card opens the report at its own address, so nothing that links
 * to a report directly — bookmarks, exports, the ⌘K palette — changed.
 *
 * Gated per card rather than as a page: the hub belongs to no single module, and each report still
 * checks its own permission when opened. A role that can open none of them is told so here instead
 * of being bounced; the sidebar already hides this page from such a role.
 */
export default async function AllReportsPage() {
  const session = await requireSession();
  const granted = new Set(await getGrantedPermissionKeys(session));
  const reports = reportPagesFor(granted);

  return (
    <div>
      <PageHeader title="All reports" description="Pick a report to open it. Each one keeps its own filters and export." />

      {reports.length === 0 ? (
        <EmptyState>Your role cannot open any report. Ask an administrator for Support Activity or Team Management access.</EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-3">
          {reports.map((report) => {
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
                <h2 className="mt-1 text-[15px] font-semibold tracking-[-0.01em] text-[color:var(--color-foreground)]">
                  {report.label}
                </h2>
                <p className="mt-1.5 text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
                  {report.description}
                </p>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
