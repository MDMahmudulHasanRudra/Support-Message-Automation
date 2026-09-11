import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";

type StatTone = "neutral" | "success" | "warning" | "danger";

const VALUE_STYLES: Record<StatTone, string> = {
  neutral: "text-[color:var(--color-foreground)]",
  success: "text-[color:var(--color-success-fg)]",
  warning: "text-[color:var(--color-warning-fg)]",
  danger: "text-[color:var(--color-danger-fg)]",
};

// A tone is a signal, so it gets a visible edge marker rather than only a colored
// number — the number alone is easy to miss when eight tiles sit in one grid.
const RAIL_STYLES: Record<StatTone, string> = {
  neutral: "bg-[var(--color-border-strong)]",
  success: "bg-[var(--color-success)]",
  warning: "bg-[var(--color-warning)]",
  danger: "bg-[var(--color-danger)]",
};

/**
 * A number, and — when there is somewhere honest to send you — the way to the rows behind it.
 *
 * `href` is optional on purpose and should stay that way. A tile that navigates to a page where
 * the reader has to rebuild the dashboard's own query by hand is worse than one that does not
 * move: it promises the eighteen items and delivers a search box. Only pass an href that lands on
 * those rows already filtered — the one card with no such destination (the outbound queue, which
 * no page lists in full) is deliberately left inert rather than pointed somewhere approximate.
 */
export function StatTile({
  label,
  value,
  hint,
  tone = "neutral",
  href,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: StatTone;
  /** Where the rows behind this number live, already filtered. Omit when nowhere does. */
  href?: string;
}) {
  const shell =
    "group relative block overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4.5 shadow-[var(--shadow-xs),var(--highlight-top)] transition-[box-shadow,border-color,transform] duration-[var(--duration-base)] ease-[var(--ease-out)] hover:-translate-y-px hover:border-[var(--color-border-strong)] hover:shadow-[var(--shadow-md)]";

  const body = (
    <>
      <span
        aria-hidden
        className={`absolute inset-y-3 left-0 w-[2px] rounded-full transition-opacity duration-[var(--duration-base)] ${RAIL_STYLES[tone]} ${
          tone === "neutral" ? "opacity-0 group-hover:opacity-100" : "opacity-100"
        }`}
      />
      <p className="text-[13px] font-medium leading-none text-[color:var(--color-muted-foreground)]">
        {label}
      </p>
      <p
        className={`tabular mt-3 text-[30px] font-semibold leading-none tracking-[-0.02em] ${VALUE_STYLES[tone]}`}
      >
        {value}
      </p>
      {hint ? (
        <p className="mt-2 text-xs leading-snug text-[color:var(--color-muted-foreground)]">{hint}</p>
      ) : null}

      {/* The only visual difference between a tile that navigates and one that does not. It stays
          out of the way until the cursor arrives, because eight permanent arrows on one grid is
          decoration competing with the numbers the grid exists to show. */}
      {href ? (
        <ArrowUpRight
          aria-hidden
          className="absolute right-4 top-4 size-3.5 text-[color:var(--color-muted-foreground)] opacity-0 transition-opacity duration-[var(--duration-base)] group-hover:opacity-100 group-focus-visible:opacity-100"
        />
      ) : null}
    </>
  );

  // A real anchor, not a div with onClick: middle-click, ctrl-click and "open in new tab" are how
  // somebody triages a dashboard, and a handler would break all three.
  if (!href) return <div className={shell}>{body}</div>;

  return (
    <Link
      href={href}
      className={`${shell} cursor-pointer active:translate-y-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-background)]`}
    >
      {body}
    </Link>
  );
}
