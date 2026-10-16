/**
 * A stable colour per group participant, so a busy group reads as several people rather than one
 * column of grey names. Derived from the chart identity slots (`--chart-1..6`, which already have
 * light and dark values) mixed toward the foreground colour: the raw chart amber is about 2:1 on
 * white, far too faint for an 11px name, and mixing toward the text colour darkens it in light mode
 * and lightens it in dark mode, keeping every name readable on its own surface.
 *
 * The colour only tells speakers apart; it never stands in for the name, which is always written.
 */
const SLOTS = 6;

function hash(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function senderColor(key: string): string {
  const slot = (hash(key) % SLOTS) + 1;
  return `color-mix(in oklab, var(--chart-${slot}) 68%, var(--color-foreground))`;
}
