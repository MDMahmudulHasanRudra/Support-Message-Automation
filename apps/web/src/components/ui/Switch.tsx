import type { InputHTMLAttributes, ReactNode } from "react";

/**
 * A standalone on/off control — use for a single boolean setting (a feature flag, a simulated
 * condition in a test form). For an item inside a multi-select list (bulk table selection, a
 * group picker), use `Checkbox` instead; this is a presentational distinction only — both submit
 * the same `name`/`"on"` form-data shape.
 */
export function Switch({
  className = "",
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <span className={`relative inline-flex h-5 w-9 shrink-0 items-center ${className}`}>
      <input type="checkbox" role="switch" className="peer sr-only" {...props} />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-full bg-[var(--color-neutral-border)] transition-colors duration-[var(--duration-base)] ease-[var(--ease-out)] peer-checked:bg-[var(--color-primary)] peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--color-focus-ring)]/40 peer-focus-visible:ring-offset-1 peer-disabled:opacity-50"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute left-0.5 top-0.5 size-4 rounded-full bg-white shadow-[var(--shadow-sm)] transition-transform duration-[var(--duration-base)] ease-[var(--ease-out)] peer-checked:translate-x-4"
      />
    </span>
  );
}

export function SwitchField({
  label,
  description,
  className = "",
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; description?: ReactNode }) {
  return (
    <label
      className={`flex cursor-pointer items-start justify-between gap-4 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3.5 transition-colors duration-150 hover:border-[var(--color-border-strong)] ${className}`}
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium text-[color:var(--color-foreground)]">{label}</span>
        {description ? (
          <span className="mt-0.5 block text-xs text-[color:var(--color-muted-foreground)]">{description}</span>
        ) : null}
      </span>
      <Switch className="mt-0.5 shrink-0" {...props} />
    </label>
  );
}
