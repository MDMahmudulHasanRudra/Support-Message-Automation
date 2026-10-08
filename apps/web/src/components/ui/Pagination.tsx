import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "@/components/ProjectLink";
import type { ReactNode } from "react";

export function Pagination({
  page,
  pageSize,
  total,
  buildHref,
  pageSizeOptions,
  buildPageSizeHref,
  sticky = false,
}: {
  page: number;
  pageSize: number;
  total: number;
  buildHref: (page: number) => string;
  /** Offered page sizes, e.g. [50, 500, 1000]. Omit to keep the fixed page size this had before. */
  pageSizeOptions?: number[];
  /** Required alongside pageSizeOptions — same URL-param contract as buildHref, but swapping the size. */
  buildPageSizeHref?: (size: number) => string;
  /**
   * Pins the bar to the bottom of the nearest scrolling ancestor (this app's `<main>`) so a long
   * table can be scrolled without losing reach of Previous/Next and the page-size switcher. Opt-in
   * because a short list — most callers — would otherwise show a bar floating mid-page the moment
   * content is shorter than the viewport.
   */
  sticky?: boolean;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const hasPrev = page > 1;
  const hasNext = page < totalPages;
  const rangeStart = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(page * pageSize, total);

  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-3 px-1 py-3.5 text-[13px] text-[color:var(--color-muted-foreground)] ${
        sticky
          ? "sticky bottom-0 z-10 -mx-5 border-t border-[var(--color-border)] bg-[var(--color-background)]/95 px-5 backdrop-blur-sm sm:-mx-8 sm:px-8"
          : ""
      }`}
    >
      <p className="tabular">
        {total === 0 ? (
          "0 results"
        ) : (
          <>
            <span className="font-medium text-[color:var(--color-foreground)]">
              {rangeStart}–{rangeEnd}
            </span>{" "}
            of {total}
          </>
        )}
      </p>

      {pageSizeOptions && buildPageSizeHref ? (
        <div className="flex items-center gap-1.5">
          <span className="text-xs">Show</span>
          {pageSizeOptions.map((size) => (
            <PageSizeLink key={size} href={buildPageSizeHref(size)} active={size === pageSize} label={String(size)} />
          ))}
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <PaginationLink href={buildHref(page - 1)} disabled={!hasPrev} label="Previous page">
          <ChevronLeft className="size-3.5" aria-hidden />
          Previous
        </PaginationLink>
        <span className="tabular px-1 text-xs font-medium text-[color:var(--color-foreground)]">
          Page {page} of {totalPages}
        </span>
        <PaginationLink href={buildHref(page + 1)} disabled={!hasNext} label="Next page">
          Next
          <ChevronRight className="size-3.5" aria-hidden />
        </PaginationLink>
      </div>
    </div>
  );
}

function PageSizeLink({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={`rounded-full px-2.5 py-1 text-xs tabular transition-colors ${
        active
          ? "bg-[var(--color-primary)] text-[var(--color-on-primary)]"
          : "bg-[var(--color-neutral-bg)] text-[color:var(--color-neutral-fg)] hover:bg-[var(--color-border)]"
      }`}
    >
      {label}
    </Link>
  );
}

const PAGINATION_BASE =
  "flex h-8 items-center gap-1 rounded-[var(--radius-sm)] border px-2.5 text-xs font-medium transition-[border-color,background-color,color] duration-[var(--duration-fast)]";

function PaginationLink({
  href,
  disabled,
  label,
  children,
}: {
  href: string;
  disabled: boolean;
  label: string;
  children: ReactNode;
}) {
  if (disabled) {
    return (
      <span
        aria-disabled="true"
        aria-label={label}
        className={`${PAGINATION_BASE} cursor-not-allowed border-[var(--color-border)] text-[color:var(--color-muted-foreground)] opacity-60`}
      >
        {children}
      </span>
    );
  }
  return (
    <Link
      href={href}
      aria-label={label}
      className={`${PAGINATION_BASE} border-[var(--color-border-strong)] text-[color:var(--color-foreground)] shadow-[var(--shadow-xs),var(--highlight-top)] hover:border-[var(--color-muted-foreground)]/50 hover:bg-[var(--color-neutral-bg)]`}
    >
      {children}
    </Link>
  );
}
