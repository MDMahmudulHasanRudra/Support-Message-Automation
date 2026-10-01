import { formatCount } from "./chartUtils";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * A weekday × hour grid of counts — magnitude, so ONE hue, light to dark (a sequential scale),
 * never a rainbow. Each cell's intensity is its share of the busiest cell, mixed from the surface
 * colour so it holds in both themes; zero is the bare surface. Every cell carries its exact value
 * in a tooltip and an accessible label, and the same figures are in the table below it, so nothing
 * is readable from colour alone.
 */
export function Heatmap({ grid, unitLabel, ariaLabel }: { grid: number[][]; unitLabel: string; ariaLabel: string }) {
  const peak = Math.max(0, ...grid.flat());
  const shade = (value: number) =>
    value === 0 || peak === 0
      ? "var(--color-surface-sunken)"
      : `color-mix(in oklab, var(--chart-1) ${Math.round(18 + (value / peak) * 82)}%, var(--color-surface))`;

  return (
    <div className="overflow-x-auto" role="img" aria-label={ariaLabel}>
      <div className="grid min-w-[40rem] grid-cols-[2.5rem_repeat(24,minmax(0,1fr))] gap-[2px] text-[10px]">
        <span />
        {Array.from({ length: 24 }, (_, hour) => (
          <span key={hour} className="tabular text-center text-[color:var(--color-subtle-foreground)]">
            {hour % 3 === 0 ? String(hour).padStart(2, "0") : ""}
          </span>
        ))}
        {grid.map((row, weekday) => (
          <div key={weekday} className="contents">
            <span className="self-center pr-1 text-[11px] text-[color:var(--color-muted-foreground)]">{DAYS[weekday]}</span>
            {row.map((value, hour) => (
              <span
                key={hour}
                title={`${DAYS[weekday]} ${String(hour).padStart(2, "0")}:00 — ${formatCount(value)} ${unitLabel}`}
                className="aspect-square rounded-[3px]"
                style={{ background: shade(value) }}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2 text-[11px] text-[color:var(--color-muted-foreground)]">
        <span>0</span>
        {[0.2, 0.4, 0.6, 0.8, 1].map((t) => (
          <span key={t} className="size-3 rounded-[3px]" style={{ background: shade(Math.max(1, t * peak)) }} />
        ))}
        <span className="tabular">{formatCount(peak)} {unitLabel} (busiest hour)</span>
      </div>
    </div>
  );
}
