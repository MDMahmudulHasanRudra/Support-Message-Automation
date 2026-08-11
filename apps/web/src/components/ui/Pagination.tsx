import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

export function Pagination({
  page,
  pageSize,
  total,
  buildHref,
}: {
  page: number;
  pageSize: number;
  total: number;
  buildHref: (page: number) => string;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const hasPrev = page > 1;
  const hasNext = page < totalPages;
  const rangeStart = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(page * pageSize, total);

  return (
    <div className="flex items-center justify-between gap-4 px-1 py-3 text-sm text-[color:var(--color-muted-foreground)]">
      <p>{total === 0 ? "0 results" : `${rangeStart}–${rangeEnd} of ${total}`}</p>
      <div className="flex items-center gap-2">
        <PaginationLink href={buildHref(page - 1)} disabled={!hasPrev} label="Previous page">
          <ChevronLeft className="size-4" aria-hidden />
          Previous
        </PaginationLink>
        <span className="text-xs">
          Page {page} of {totalPages}
        </span>
        <PaginationLink href={buildHref(page + 1)} disabled={!hasNext} label="Next page">
          Next
          <ChevronRight className="size-4" aria-hidden />
        </PaginationLink>
      </div>
    </div>
  );
}

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
        className="flex cursor-not-allowed items-center gap-1 rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-sm text-[color:var(--color-muted-foreground)] opacity-50"
      >
        {children}
      </span>
    );
  }
  return (
    <Link
      href={href}
      aria-label={label}
      className="flex items-center gap-1 rounded-md border border-[var(--color-border-strong)] px-2.5 py-1.5 text-sm text-[color:var(--color-foreground)] transition-colors hover:bg-[var(--color-neutral-bg)]"
    >
      {children}
    </Link>
  );
}
