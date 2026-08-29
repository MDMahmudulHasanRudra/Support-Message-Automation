import { formatCompact, formatCount, percentOf } from "./chartUtils";

export interface DonutSlice {
  key: string;
  label: string;
  value: number;
  color: string;
}

const RADIUS = 54;
const STROKE = 16;
const CENTER = 64;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** The surface gap between touching segments, in viewBox units (~2px as rendered). */
const GAP = 2;

/**
 * Part-to-whole at a glance. Capped at six segments upstream, because past that
 * adjacent slices blur and a table is the honest form.
 *
 * The legend carries the value and share for every segment, which is also what
 * discharges the palette's contrast relief rule: three of the categorical slots sit
 * below 3:1 on white, so no segment is ever readable by its fill alone.
 */
export function DonutChart({
  slices,
  total,
  centerLabel,
  ariaLabel,
}: {
  slices: DonutSlice[];
  total: number;
  centerLabel: string;
  ariaLabel: string;
}) {
  const drawable = slices.filter((slice) => slice.value > 0);
  const gap = drawable.length > 1 ? GAP : 0;

  let cumulative = 0;
  const arcs = drawable.map((slice) => {
    const length = (slice.value / total) * CIRCUMFERENCE;
    const arc = { slice, length: Math.max(length - gap, 0), offset: cumulative };
    cumulative += length;
    return arc;
  });

  return (
    <div className="flex flex-wrap items-center gap-6">
      <div className="relative shrink-0" style={{ width: 132, height: 132 }}>
        <svg viewBox="0 0 128 128" className="size-full" role="img" aria-label={ariaLabel}>
          {total === 0 ? (
            <circle
              cx={CENTER}
              cy={CENTER}
              r={RADIUS}
              fill="none"
              stroke="var(--chart-track)"
              strokeWidth={STROKE}
            />
          ) : (
            arcs.map(({ slice, length, offset }) =>
              length <= 0 ? null : (
                <circle
                  key={slice.key}
                  cx={CENTER}
                  cy={CENTER}
                  r={RADIUS}
                  fill="none"
                  stroke={slice.color}
                  strokeWidth={STROKE}
                  strokeDasharray={`${length} ${CIRCUMFERENCE - length}`}
                  strokeDashoffset={-offset}
                  transform={`rotate(-90 ${CENTER} ${CENTER})`}
                >
                  <title>{`${slice.label} — ${formatCount(slice.value)} (${Math.round(percentOf(slice.value, total))}%)`}</title>
                </circle>
              ),
            )
          )}
        </svg>

        {/* Proportional figures, not tabular — a standalone number at this size
            looks loose with every digit set to the width of a zero. */}
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-semibold leading-none tracking-[-0.02em] text-[color:var(--color-foreground)]">
            {formatCompact(total)}
          </span>
          <span className="mt-1 text-[11px] text-[color:var(--color-muted-foreground)]">{centerLabel}</span>
        </div>
      </div>

      <dl className="min-w-[10rem] flex-1 space-y-2">
        {slices.length === 0 ? (
          <p className="text-[13px] text-[color:var(--color-muted-foreground)]">
            No decisions recorded in this window.
          </p>
        ) : (
          slices.map((slice) => (
            <div key={slice.key} className="flex items-center gap-2.5 text-[13px]">
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-[2px]"
                style={{ backgroundColor: slice.color }}
              />
              <dt className="min-w-0 flex-1 truncate text-[color:var(--color-muted-foreground)]">
                {slice.label}
              </dt>
              <dd className="tabular m-0 shrink-0 font-medium text-[color:var(--color-foreground)]">
                {formatCount(slice.value)}
                <span className="ml-1.5 font-normal text-[color:var(--color-muted-foreground)]">
                  {Math.round(percentOf(slice.value, total))}%
                </span>
              </dd>
            </div>
          ))
        )}
      </dl>
    </div>
  );
}
