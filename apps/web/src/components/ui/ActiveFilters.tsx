import Link from "next/link";
import { X } from "lucide-react";
import type { ReactNode } from "react";

export interface ActiveFilter {
  /** What the filter is, e.g. "Search" or "Category". */
  label: string;
  /** What it is set to, shown verbatim — the operator's own words where they typed them. */
  value: string;
  /** Where removing just this one lands. Every other filter must survive it. */
  removeHref: string;
}

/**
 * What is currently narrowing the list, and how to undo any one part of it.
 *
 * The filter controls on these pages say what CAN be filtered, never what IS. A search term sits
 * in a box that scrolls out of view, a chip's active state is a colour, and a category lives in a
 * closed select — so "why am I only seeing 12 of 1,192?" had no answer on screen, and the only way
 * back was to empty each control by hand and remember which ones you had touched.
 *
 * Each filter is removable on its own, which is the property that matters: narrowing is iterative,
 * and a control that could only reset everything would punish the operator for the last step by
 * discarding the first four.
 *
 * Renders nothing when nothing is applied — an empty "Filters:" row on an unfiltered list is
 * furniture.
 */
export function ActiveFilters({
  filters,
  clearAllHref,
  resultCount,
  totalCount,
  noun = { singular: "result", plural: "results" },
}: {
  filters: ActiveFilter[];
  /** The unfiltered list. Kept as a real href so it is middle-clickable like every other link here. */
  clearAllHref: string;
  /** How many rows match. Shown as "12 of 1,192" so the narrowing is legible as a proportion. */
  resultCount?: number;
  totalCount?: number;
  noun?: { singular: string; plural: string };
}) {
  if (filters.length === 0) return null;

  const showCount = resultCount !== undefined;
  const word = resultCount === 1 ? noun.singular : noun.plural;

  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[13px]">
      <span className="text-[color:var(--color-muted-foreground)]">Filtered by</span>

      {filters.map((filter) => (
        <FilterPill key={`${filter.label}:${filter.value}`} href={filter.removeHref} label={filter.label}>
          {filter.value}
        </FilterPill>
      ))}

      {showCount ? (
        <span className="tabular text-[color:var(--color-muted-foreground)]">
          <span className="font-medium text-[color:var(--color-foreground)]">
            {resultCount!.toLocaleString()}
          </span>
          {totalCount !== undefined ? ` of ${totalCount.toLocaleString()}` : ""} {word}
        </span>
      ) : null}

      <Link
        href={clearAllHref}
        className="text-[13px] text-[color:var(--color-muted-foreground)] underline decoration-dotted underline-offset-2 transition-colors hover:text-[color:var(--color-foreground)]"
      >
        Clear all
      </Link>
    </div>
  );
}

function FilterPill({ href, label, children }: { href: string; label: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-[var(--color-border-strong)] bg-[var(--color-surface-sunken)] py-0.5 pl-2.5 pr-1 text-xs">
      <span className="text-[color:var(--color-muted-foreground)]">{label}:</span>
      <span className="max-w-48 truncate font-medium text-[color:var(--color-foreground)]">{children}</span>
      <Link
        href={href}
        aria-label={`Remove ${label} filter`}
        className="flex size-4 items-center justify-center rounded-full text-[color:var(--color-muted-foreground)] transition-colors hover:bg-[var(--color-border)] hover:text-[color:var(--color-foreground)]"
      >
        <X className="size-3" aria-hidden />
      </Link>
    </span>
  );
}

/**
 * The empty state for a list that HAS rows, just none matching.
 *
 * "No results" alone reads as "there is nothing here", which sends somebody looking for data they
 * already have. Naming the filters that emptied it, and offering the way back in the same breath,
 * makes the difference between a dead end and a wrong turn.
 */
export function NoFilterResults({
  clearAllHref,
  filters,
  children,
}: {
  clearAllHref: string;
  filters: ActiveFilter[];
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border-strong)] px-6 py-12 text-center">
      <p className="text-sm font-medium text-[color:var(--color-foreground)]">{children ?? "Nothing matches these filters."}</p>
      {filters.length > 0 ? (
        <p className="max-w-lg text-[13px] text-[color:var(--color-muted-foreground)]">
          Narrowed by{" "}
          {filters.map((filter, index) => (
            <span key={`${filter.label}:${filter.value}`}>
              {index > 0 ? (index === filters.length - 1 ? " and " : ", ") : ""}
              <span className="font-medium text-[color:var(--color-foreground)]">
                {filter.label.toLowerCase()} “{filter.value}”
              </span>
            </span>
          ))}
          . Remove one to widen the search.
        </p>
      ) : null}
      <Link
        href={clearAllHref}
        className="mt-1 text-[13px] text-[color:var(--color-primary)] underline underline-offset-2"
      >
        Clear all filters
      </Link>
    </div>
  );
}
