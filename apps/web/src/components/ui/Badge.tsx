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
  pulse = false,
  children,
}: {
  color?: BadgeColor;
  dot?: boolean;
  /** Only for a dot standing in for a genuinely live/real-time state — not every positive status needs this. */
  pulse?: boolean;
  children: ReactNode;
}) {
  return (
    // A squared-off chip rather than a full pill: these sit in dense table cells
    // next to monospace ids, and the flatter shape reads as a state label instead
    // of a marketing tag.
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-[var(--radius-sm)] px-2 py-[3px] text-[11px] font-medium leading-4 tracking-[0.01em] ${BADGE_STYLES[color]}`}
    >
      {dot ? (
        pulse ? (
          <span className="relative inline-flex size-1.5 shrink-0" aria-hidden>
            <span className={`absolute inline-flex size-full animate-ping rounded-full opacity-60 ${DOT_STYLES[color]}`} />
            <span className={`relative inline-flex size-1.5 rounded-full ${DOT_STYLES[color]}`} />
          </span>
        ) : (
          <span className={`size-1.5 shrink-0 rounded-full ${DOT_STYLES[color]}`} aria-hidden />
        )
      ) : null}
      {children}
    </span>
  );
}

export function StatusDot({ color = "gray", pulse = false }: { color?: BadgeColor; pulse?: boolean }) {
  if (!pulse) {
    return <span className={`inline-block size-2 rounded-full ${DOT_STYLES[color]}`} aria-hidden />;
  }
  return (
    <span className="relative inline-flex size-2" aria-hidden>
      <span className={`absolute inline-flex size-full animate-ping rounded-full opacity-60 ${DOT_STYLES[color]}`} />
      <span className={`relative inline-flex size-2 rounded-full ${DOT_STYLES[color]}`} />
    </span>
  );
}
