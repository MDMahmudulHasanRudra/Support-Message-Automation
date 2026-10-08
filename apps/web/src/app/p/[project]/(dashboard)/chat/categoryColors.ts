import type { ChatCategoryColor } from "@support-automation/shared";

/**
 * Category colour → the Tailwind class for its dot.
 *
 * A literal map rather than an interpolated class name (`bg-${color}-500`), because Tailwind scans
 * source text for complete class names and would emit none of these — the dots would silently
 * render transparent in a production build while looking correct in dev.
 *
 * Values come from the chart palette rather than the status tokens. A category is an identity, not
 * a state: painting one green would read as "healthy" next to a red one reading as "broken", when
 * both are just folders somebody named.
 */
const DOTS: Record<ChatCategoryColor, string> = {
  gray: "bg-[var(--color-border-strong)]",
  blue: "bg-[var(--chart-1)]",
  green: "bg-[var(--chart-3)]",
  amber: "bg-[var(--chart-4)]",
  red: "bg-[var(--chart-2)]",
  purple: "bg-[var(--chart-5)]",
  teal: "bg-[var(--chart-6)]",
  pink: "bg-[var(--chart-5)]",
};

/** Falls back to grey for a colour saved before the palette changed, rather than rendering nothing. */
export function categoryDotClass(color: string): string {
  return DOTS[color as ChatCategoryColor] ?? DOTS.gray;
}
