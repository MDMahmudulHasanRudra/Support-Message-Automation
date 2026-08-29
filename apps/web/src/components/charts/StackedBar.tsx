import { formatCount, percentOf } from "./chartUtils";

export interface StackedSegment {
  key: string;
  label: string;
  value: number;
  color: string;
}

/**
 * Part-to-whole for a handful of states. These segments mean good/bad, so they
 * wear the app's status tokens rather than the categorical chart slots — and each
 * one ships its label and count in the legend, never colour alone.
 *
 * The 2px separation between segments is a gap in the surface colour, not a stroke
 * drawn around each fill.
 */
export function StackedBar({
  segments,
  total,
  ariaLabel,
  emptyMessage = "Nothing queued in this window.",
}: {
  segments: StackedSegment[];
  total: number;
  ariaLabel: string;
  emptyMessage?: string;
}) {
  if (total === 0 || segments.length === 0) {
    return (
      <div>
        <div className="h-2.5 w-full rounded-full bg-[var(--chart-track)]" aria-hidden />
        <p className="mt-3 text-[13px] text-[color:var(--color-muted-foreground)]">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div>
      <div
        className="flex h-2.5 w-full gap-[2px] overflow-hidden rounded-full bg-[var(--color-surface)]"
        role="img"
        aria-label={ariaLabel}
      >
        {segments.map((segment) => (
          <div
            key={segment.key}
            title={`${segment.label} — ${formatCount(segment.value)} (${Math.round(percentOf(segment.value, total))}%)`}
            className="h-full first:rounded-l-full last:rounded-r-full"
            style={{
              backgroundColor: segment.color,
              width: `${Math.max(1.5, percentOf(segment.value, total))}%`,
            }}
          />
        ))}
      </div>

      <dl className="mt-4 space-y-2">
        {segments.map((segment) => (
          <div key={segment.key} className="flex items-center gap-2.5 text-[13px]">
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: segment.color }}
            />
            <dt className="min-w-0 flex-1 truncate text-[color:var(--color-muted-foreground)]">
              {segment.label}
            </dt>
            <dd className="tabular m-0 shrink-0 font-medium text-[color:var(--color-foreground)]">
              {formatCount(segment.value)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
