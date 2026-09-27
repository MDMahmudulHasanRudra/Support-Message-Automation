import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";
import { Card } from "@/components/ui";

/**
 * The frame every metrics chart sits in: a title that names the series (which is
 * why single-series charts need no legend box), the window it covers, and an
 * optional headline figure on the right.
 */
/**
 * `href` renders a small link in the header rather than wrapping the whole card.
 *
 * A chart is content somebody reads — hovering a series, selecting a number off an axis — and
 * making the entire surface one anchor turns every one of those into a navigation. The tiles next
 * door are a single figure with nothing to read, which is why they take the opposite approach.
 */
export function ChartCard({
  title,
  description,
  headline,
  children,
  className = "",
  href,
  linkLabel = "View",
}: {
  title: string;
  description?: string;
  /** A single figure or badge summarising the plot — the one number worth reading first. */
  headline?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Where the rows behind this plot live, already filtered. Omit when nowhere lists them. */
  href?: string;
  linkLabel?: string;
}) {
  return (
    <Card className={`flex flex-col p-5 ${className}`}>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold tracking-[-0.01em] text-[color:var(--color-foreground)]">
            {title}
          </h3>
          {description ? (
            <p className="mt-1 text-[11px] leading-relaxed text-[color:var(--color-muted-foreground)]">
              {description}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-start gap-3">
          {headline ? <div className="text-right">{headline}</div> : null}
          {href ? (
            <Link
              href={href}
              className="flex shrink-0 items-center gap-0.5 rounded-[var(--radius-xs)] text-[11px] font-medium text-[color:var(--color-muted-foreground)] transition-colors duration-[var(--duration-fast)] hover:text-[color:var(--color-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
            >
              {linkLabel}
              <ArrowUpRight className="size-3" aria-hidden />
            </Link>
          ) : null}
        </div>
      </div>
      {/* Centred in whatever height the row gives it. Overview pairs each wide chart with a narrow
          card in the same row, and a donut beside an area chart is shorter than its row — top-
          aligned, that left a band of blank card under every short chart. */}
      <div className="flex flex-1 flex-col justify-center">{children}</div>
    </Card>
  );
}

/** The headline figure slot: a value with an optional signed change beneath it. */
export function ChartHeadline({
  value,
  delta,
  deltaTone = "neutral",
  caption,
}: {
  value: ReactNode;
  delta?: ReactNode;
  deltaTone?: "neutral" | "up" | "down";
  caption?: string;
}) {
  const deltaClass =
    deltaTone === "up"
      ? "text-[color:var(--color-success-fg)]"
      : deltaTone === "down"
        ? "text-[color:var(--color-danger-fg)]"
        : "text-[color:var(--color-muted-foreground)]";

  return (
    <>
      <p className="text-xl font-semibold leading-none tracking-[-0.02em] text-[color:var(--color-foreground)]">
        {value}
      </p>
      {delta ? <p className={`mt-1.5 text-[11px] font-medium ${deltaClass}`}>{delta}</p> : null}
      {caption ? (
        <p className="mt-1 text-[11px] text-[color:var(--color-muted-foreground)]">{caption}</p>
      ) : null}
    </>
  );
}
