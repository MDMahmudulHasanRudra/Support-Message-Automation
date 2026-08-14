import type { ReactNode } from "react";

type StatTone = "neutral" | "success" | "warning" | "danger";

const TONE_STYLES: Record<StatTone, string> = {
  neutral: "text-[color:var(--color-foreground)]",
  success: "text-[color:var(--color-success-fg)]",
  warning: "text-[color:var(--color-warning-fg)]",
  danger: "text-[color:var(--color-danger-fg)]",
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
    <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-[var(--shadow-xs)] transition-shadow duration-200 hover:shadow-[var(--shadow-sm)]">
      <p className="text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
        {label}
      </p>
      <p className={`mt-2 text-[28px] font-semibold leading-none tabular-nums ${TONE_STYLES[tone]}`}>{value}</p>
      {hint ? <p className="mt-2 text-xs text-[color:var(--color-muted-foreground)]">{hint}</p> : null}
    </div>
  );
}
