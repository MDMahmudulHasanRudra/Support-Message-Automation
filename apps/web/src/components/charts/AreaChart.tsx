import { formatCount, idFromLabel, niceMax } from "./chartUtils";

export interface AreaPoint {
  label: string;
  value: number;
}

/**
 * Trend over time, single series — so no legend box: the card title already names
 * what is plotted.
 *
 * The plot is an SVG stretched with `preserveAspectRatio="none"` (strokes held at a
 * true width by `vector-effect`), but every piece of text and the endpoint marker
 * are HTML layered over it, so nothing is ever rendered at a distorted scale.
 */
export function AreaChart({
  data,
  ariaLabel,
  unitLabel = "messages",
  height = 168,
}: {
  data: AreaPoint[];
  ariaLabel: string;
  unitLabel?: string;
  height?: number;
}) {
  if (data.length < 2) {
    return (
      <p className="py-10 text-center text-[13px] text-[color:var(--color-muted-foreground)]">
        Not enough history yet to draw a trend.
      </p>
    );
  }

  const gradientId = idFromLabel("area", ariaLabel);
  const max = niceMax(Math.max(...data.map((d) => d.value)));
  const lastIndex = data.length - 1;

  const points = data.map((point, index) => ({
    x: (index / lastIndex) * 100,
    y: 100 - (point.value / max) * 100,
  }));

  const line = points.map((p) => `${p.x},${p.y}`).join(" ");
  const area = `M0,100 L${points.map((p) => `${p.x},${p.y}`).join(" L")} L100,100 Z`;
  const last = points[lastIndex];

  return (
    <figure className="m-0">
      <div className="flex gap-3">
        {/* Y ticks — they carry the values that aren't directly labelled. */}
        <div
          className="tabular flex w-10 shrink-0 flex-col justify-between text-right text-[10px] text-[color:var(--color-muted-foreground)]"
          style={{ height }}
          aria-hidden
        >
          <span>{formatCount(max)}</span>
          <span>{formatCount(Math.round(max / 2))}</span>
          <span>0</span>
        </div>

        <div className="relative min-w-0 flex-1" style={{ height }}>
          {/* Solid hairline gridlines, one step off the surface — never dashed. */}
          {[0, 50, 100].map((top) => (
            <span
              key={top}
              aria-hidden
              className="absolute inset-x-0 h-px bg-[var(--chart-grid)]"
              style={{ top: `${top}%` }}
            />
          ))}

          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="absolute inset-0 size-full overflow-visible text-[color:var(--chart-1)]"
            role="img"
            aria-label={ariaLabel}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="currentColor" stopOpacity="0.18" />
                <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d={area} fill={`url(#${gradientId})`} />
            <polyline
              points={line}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>

          {/* Endpoint marker: HTML, so it stays a circle under a stretched viewBox.
              The 2px surface ring is the separator, not a stroke on the mark. */}
          <span
            aria-hidden
            className="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--chart-1)] shadow-[0_0_0_2px_var(--color-surface)]"
            style={{ left: `${last.x}%`, top: `${last.y}%` }}
          />

          {/* Full-height hover columns — a real hit target rather than a 2px line,
              and the native tooltip means no client JavaScript ships for it. */}
          <div className="absolute inset-0 flex">
            {data.map((point) => (
              <div
                key={point.label}
                title={`${point.label} — ${formatCount(point.value)} ${unitLabel}`}
                className="h-full flex-1 transition-colors duration-[var(--duration-fast)] hover:bg-[var(--color-neutral-bg)]/50"
              />
            ))}
          </div>
        </div>
      </div>

      {/* Every other tick, so the row stays readable at narrow widths and still
          ends on the most recent bucket. */}
      <div className="mt-2 flex pl-[3.25rem]">
        {data.map((point, index) => (
          <span
            key={point.label}
            className="flex-1 text-center text-[10px] text-[color:var(--color-muted-foreground)]"
          >
            {index % 2 === 1 ? point.label : " "}
          </span>
        ))}
      </div>
    </figure>
  );
}
