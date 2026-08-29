/**
 * Shared helpers for the hand-rolled chart set. There is deliberately no charting
 * library in this app (see CLAUDE.md) — these are small enough that a dependency
 * would cost more than it saves, and staying in plain SVG/HTML keeps every chart a
 * Server Component with no client bundle at all.
 */

/** Axis ticks and table figures line up vertically, so they get tabular figures. */
export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/** Big standalone values stay readable past a few thousand. */
export function formatCompact(value: number): string {
  if (value < 10_000) return value.toLocaleString("en-US");
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

/**
 * Rounds an axis maximum up to a clean 1/2/5×10ⁿ so the ticks read as round
 * numbers instead of the raw peak. Never returns 0 — a flat-zero series still
 * needs a scale to draw against.
 */
export function niceMax(value: number): number {
  if (value <= 0) return 4;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

/**
 * SVG needs unique ids for gradients, and these render inside Server Components
 * where `useId` is unavailable. Deriving from the chart's own aria-label is
 * deterministic across server and client; two charts sharing a label would share
 * an identical gradient anyway.
 */
export function idFromLabel(prefix: string, ariaLabel: string): string {
  return `${prefix}-${ariaLabel.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}`;
}

export function percentOf(value: number, total: number): number {
  return total === 0 ? 0 : (value / total) * 100;
}
