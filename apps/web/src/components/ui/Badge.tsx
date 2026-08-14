import type { ReactNode } from "react";

export type BadgeColor = "green" | "red" | "yellow" | "gray" | "blue";

const BADGE_STYLES: Record<BadgeColor, string> = {
  green:
    "bg-[var(--color-success-bg)] text-[color:var(--color-success-fg)] ring-1 ring-inset ring-[var(--color-success-border)]",
  red: "bg-[var(--color-danger-bg)] text-[color:var(--color-danger-fg)] ring-1 ring-inset ring-[var(--color-danger-border)]",
  yellow:
    "bg-[var(--color-warning-bg)] text-[color:var(--color-warning-fg)] ring-1 ring-inset ring-[var(--color-warning-border)]",
  gray: "bg-[var(--color-neutral-bg)] text-[color:var(--color-neutral-fg)] ring-1 ring-inset ring-[var(--color-neutral-border)]",
  blue: "bg-[var(--color-info-bg)] text-[color:var(--color-info-fg)] ring-1 ring-inset ring-[var(--color-info-border)]",
};

const DOT_STYLES: Record<BadgeColor, string> = {
  green: "bg-[var(--color-success)]",
  red: "bg-[var(--color-danger)]",
  yellow: "bg-[var(--color-warning)]",
  gray: "bg-[color:var(--color-muted-foreground)]",
  blue: "bg-[var(--color-info)]",
};

export function Badge({
  color = "gray",
  dot = false,
  children,
}: {
  color?: BadgeColor;
  dot?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium ${BADGE_STYLES[color]}`}
    >
      {dot ? <span className={`size-1.5 shrink-0 rounded-full ${DOT_STYLES[color]}`} aria-hidden /> : null}
      {children}
    </span>
  );
}

export function StatusDot({ color = "gray" }: { color?: BadgeColor }) {
  return <span className={`inline-block size-2 rounded-full ${DOT_STYLES[color]}`} aria-hidden />;
}
