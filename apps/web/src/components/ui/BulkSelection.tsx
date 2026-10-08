"use client";

import { Button } from "./Button";

/**
 * The "you selected the page — did you mean the whole result?" prompt.
 *
 * Server-side pagination means the browser only ever holds the ids currently on screen, so a header
 * checkbox can only mean "select these 25", however many rows actually match. On a roster of 1,848
 * groups or 1,192 knowledge entries that is the difference between the action the operator asked
 * for and the one they got — and nothing on screen said so, which is the specific complaint this
 * exists to answer: filter to fifty, then act on exactly those fifty in one gesture.
 *
 * Deliberately a PROMPT rather than a silent widening. A control that quietly reached past what the
 * operator could see would be the most dangerous one in the app, so it appears only once the page
 * is fully selected, it names BOTH numbers every time, and widening is a separate, explicit click.
 *
 * It renders nothing when the page IS the whole result — there is no second meaning to offer.
 */
export function SelectAllMatchingNotice({
  pageSelectedCount,
  pageCount,
  totalMatching,
  allMatchingSelected,
  onSelectAllMatching,
  onClear,
  loading = false,
  noun = { singular: "row", plural: "rows" },
  max,
}: {
  /** How many rows on the CURRENT page are selected. */
  pageSelectedCount: number;
  /** How many rows the current page renders. */
  pageCount: number;
  /** How many rows match the current filters across every page. */
  totalMatching: number;
  /** True once the selection has been widened to the whole result set. */
  allMatchingSelected: boolean;
  /** Fetches every matching id and adds it to the selection — the caller owns that server round trip. */
  onSelectAllMatching: () => void;
  onClear: () => void;
  loading?: boolean;
  noun?: { singular: string; plural: string };
  /**
   * The caller's own ceiling on one bulk action, if it has one. Stated up front rather than
   * discovered as an error after the operator has committed to the gesture.
   */
  max?: number;
}) {
  const pageIsFullySelected = pageCount > 0 && pageSelectedCount >= pageCount;
  const thereIsMore = totalMatching > pageCount;
  if (!pageIsFullySelected || !thereIsMore) return null;

  const word = (count: number) => (count === 1 ? noun.singular : noun.plural);
  const overCap = max !== undefined && totalMatching > max;

  return (
    <div className="mb-2 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-[var(--radius-md)] border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface-sunken)] px-3.5 py-2 text-center text-[13px] text-[color:var(--color-muted-foreground)]">
      {allMatchingSelected ? (
        <>
          <span>
            All{" "}
            <span className="tabular font-medium text-[color:var(--color-foreground)]">
              {totalMatching.toLocaleString()}
            </span>{" "}
            {word(totalMatching)} matching these filters are selected.
          </span>
          <Button variant="ghost" size="sm" onClick={onClear} disabled={loading}>
            Clear selection
          </Button>
        </>
      ) : (
        <>
          <span>
            All{" "}
            <span className="tabular font-medium text-[color:var(--color-foreground)]">{pageCount}</span> on this
            page are selected.
          </span>
          {overCap ? (
            /* Named before the click, not after: a cap discovered as a rejection has already cost
               the operator the gesture they were trying to make. */
            <span>
              <span className="tabular font-medium text-[color:var(--color-foreground)]">
                {totalMatching.toLocaleString()}
              </span>{" "}
              match in total — more than the {max!.toLocaleString()} that can be actioned at once. Narrow the
              filters further.
            </span>
          ) : (
            <Button variant="ghost" size="sm" onClick={onSelectAllMatching} loading={loading}>
              Select all {totalMatching.toLocaleString()} matching these filters
            </Button>
          )}
        </>
      )}
    </div>
  );
}
