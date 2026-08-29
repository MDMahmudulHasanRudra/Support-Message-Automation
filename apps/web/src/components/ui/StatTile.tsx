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

export function StatTile({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: StatTone;
}) {
  return (
    <div className="group relative overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4.5 shadow-[var(--shadow-xs),var(--highlight-top)] transition-[box-shadow,border-color,transform] duration-[var(--duration-base)] ease-[var(--ease-out)] hover:-translate-y-px hover:border-[var(--color-border-strong)] hover:shadow-[var(--shadow-md)]">
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
    </div>
  );
}
