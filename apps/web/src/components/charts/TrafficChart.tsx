import { formatCount, idFromLabel, niceMax } from "./chartUtils";

export interface TrafficPoint {
  label: string;
  incoming: number;
  outgoing: number;
}

/**
 * Two series over time on one scale: what came in (filled, the subject) and what went out (a line over it).
 * Built like `AreaChart`: a stretched SVG for the shapes, HTML for every piece of text, a legend that names
 * both series, and a native tooltip per day carrying both exact figures, so nothing depends on colour alone.
 */
export function TrafficChart({
  data,
  ariaLabel,
  incomingLabel = "Received",
  outgoingLabel = "Sent",
  height = 188,
}: {
  data: TrafficPoint[];
  ariaLabel: string;
  incomingLabel?: string;
  outgoingLabel?: string;
  height?: number;
}) {
  if (data.length < 2) {
    return <p className="py-10 text-center text-[13px] text-[color:var(--color-muted-foreground)]">Not enough history yet to draw a trend.</p>;
  }
  const gradientId = idFromLabel("traffic", ariaLabel);
  const max = niceMax(Math.max(...data.map((d) => Math.max(d.incoming, d.outgoing))));
  const lastIndex = data.length - 1;
  const at = (value: number, index: number) => `${(index / lastIndex) * 100},${100 - (value / max) * 100}`;
  const incoming = data.map((d, i) => at(d.incoming, i));
  const outgoing = data.map((d, i) => at(d.outgoing, i));
  const area = `M0,100 L${incoming.join(" L")} L100,100 Z`;

  return (
    <figure className="m-0">
      <figcaption className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-[color:var(--color-muted-foreground)]">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="size-2.5 rounded-[3px] bg-[var(--chart-1)]" />
          {incomingLabel}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-0.5 w-3.5 rounded-full bg-[var(--chart-2)]" />
          {outgoingLabel}
        </span>
      </figcaption>
      <div className="flex gap-3">
        <div className="tabular flex w-10 shrink-0 flex-col justify-between text-right text-[10px] text-[color:var(--color-muted-foreground)]" style={{ height }} aria-hidden>
          <span>{formatCount(max)}</span>
          <span>{formatCount(Math.round(max / 2))}</span>
          <span>0</span>
        </div>
        <div className="relative min-w-0 flex-1" style={{ height }}>
          {[0, 50, 100].map((top) => (
            <span key={top} aria-hidden className="absolute inset-x-0 h-px bg-[var(--chart-grid)]" style={{ top: `${top}%` }} />
          ))}
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible" role="img" aria-label={ariaLabel}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--chart-1)" stopOpacity="0.22" />
                <stop offset="100%" stopColor="var(--chart-1)" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d={area} fill={`url(#${gradientId})`} />
            <polyline points={incoming.join(" ")} fill="none" stroke="var(--chart-1)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            <polyline points={outgoing.join(" ")} fill="none" stroke="var(--chart-2)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          </svg>
          <div className="absolute inset-0 flex">
            {data.map((point) => (
              <div
                key={point.label}
                title={`${point.label}: ${formatCount(point.incoming)} ${incomingLabel.toLowerCase()}, ${formatCount(point.outgoing)} ${outgoingLabel.toLowerCase()}`}
                className="h-full flex-1 transition-colors duration-[var(--duration-fast)] hover:bg-[var(--color-neutral-bg)]/50"
              />
            ))}
          </div>
        </div>
      </div>
      <div className="mt-2 flex pl-[3.25rem]">
        {data.map((point, index) => (
          <span key={point.label} className="min-w-0 flex-1 overflow-visible whitespace-nowrap text-center text-[11px] text-[color:var(--color-muted-foreground)]">
            <span className={index % 4 === 1 || index === data.length - 1 ? undefined : "max-sm:invisible"}>{index % 2 === 1 ? point.label : " "}</span>
          </span>
        ))}
      </div>
    </figure>
  );
}
