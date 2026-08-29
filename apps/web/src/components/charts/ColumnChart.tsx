import { formatCount, niceMax } from "./chartUtils";

export interface ColumnPoint {
  label: string;
  value: number;
}

/**
 * Magnitude across ordered buckets — one hue, because there is one series and its
 * length already encodes the value. Pure HTML/CSS: 24 flex columns need no SVG,
 * and this way the text stays crisp at every width.
 */
export function ColumnChart({
  data,
  ariaLabel,
  unitLabel = "messages",
  labelEvery = 4,
  height = 132,
}: {
  data: ColumnPoint[];
  ariaLabel: string;
  unitLabel?: string;
  /** Render an x tick every Nth bucket — 24 labels in a row is unreadable. */
  labelEvery?: number;
  height?: number;
}) {
  if (data.length === 0) {
    return (
      <p className="py-10 text-center text-[13px] text-[color:var(--color-muted-foreground)]">
        No activity in this window.
      </p>
    );
  }

  const peak = Math.max(...data.map((d) => d.value));
  const max = niceMax(peak);
  const peakIndex = data.findIndex((d) => d.value === peak);

  return (
    <figure className="m-0" role="img" aria-label={ariaLabel}>
      <div className="flex gap-3">
        <div
          className="tabular flex w-10 shrink-0 flex-col justify-between text-right text-[10px] text-[color:var(--color-muted-foreground)]"
          style={{ height }}
          aria-hidden
        >
          <span>{formatCount(max)}</span>
          <span>0</span>
        </div>

        <div className="relative min-w-0 flex-1" style={{ height }}>
          <span aria-hidden className="absolute inset-x-0 top-0 h-px bg-[var(--chart-grid)]" />
          <span aria-hidden className="absolute inset-x-0 bottom-0 h-px bg-[var(--chart-axis,var(--color-border-strong))]" />

          {/* gap-[2px] is the surface gap that separates neighbouring bars — no
              stroke is ever drawn around a mark to do that job. */}
          <div className="flex h-full items-end gap-[2px]">
            {data.map((point, index) => {
              const heightPercent = max === 0 ? 0 : (point.value / max) * 100;
              const isPeak = index === peakIndex && peak > 0;
              return (
                <div
                  key={point.label + index}
                  title={`${point.label} — ${formatCount(point.value)} ${unitLabel}`}
                  className="group flex h-full flex-1 cursor-default items-end justify-center"
                >
                  <div
                    className={`w-full max-w-6 rounded-t-[4px] transition-opacity duration-[var(--duration-fast)] group-hover:opacity-80 ${
                      isPeak ? "bg-[var(--chart-1)]" : "bg-[var(--chart-1)]/55"
                    }`}
                    style={{ height: point.value > 0 ? `max(2px, ${heightPercent}%)` : 0 }}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="mt-2 flex gap-[2px] pl-[3.25rem]">
        {data.map((point, index) => (
          <span
            key={point.label + index}
            className="flex-1 truncate text-center text-[10px] text-[color:var(--color-muted-foreground)]"
          >
            {index % labelEvery === 0 ? point.label : " "}
          </span>
        ))}
      </div>
    </figure>
  );
}
