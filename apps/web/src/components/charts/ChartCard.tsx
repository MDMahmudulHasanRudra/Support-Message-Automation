import type { ReactNode } from "react";
import { Card } from "@/components/ui";

/**
 * The frame every metrics chart sits in: a title that names the series (which is
 * why single-series charts need no legend box), the window it covers, and an
 * optional headline figure on the right.
 */
export function ChartCard({
  title,
  description,
  headline,
  children,
  className = "",
}: {
  title: string;
  description?: string;
  /** A single figure or badge summarising the plot — the one number worth reading first. */
  headline?: ReactNode;
  children: ReactNode;
  className?: string;
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
        {headline ? <div className="shrink-0 text-right">{headline}</div> : null}
      </div>
      <div className="flex-1">{children}</div>
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
