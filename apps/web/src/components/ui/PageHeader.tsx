import type { ReactNode } from "react";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-8 flex flex-wrap items-start justify-between gap-x-4 gap-y-3 border-b border-[var(--color-border)] pb-6">
      <div className="min-w-0">
        <h1 className="text-[27px] font-semibold leading-[1.15] tracking-[-0.025em] text-[color:var(--color-foreground)]">
          {title}
        </h1>
        {description ? (
          <p className="mt-2 max-w-[62ch] text-sm leading-relaxed text-[color:var(--color-muted-foreground)]">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function SectionHeader({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="mb-3">
      <h2 className="text-sm font-semibold tracking-[-0.01em] text-[color:var(--color-foreground)]">
        {title}
      </h2>
      {description ? (
        <p className="mt-1 text-xs leading-relaxed text-[color:var(--color-muted-foreground)]">
          {description}
        </p>
      ) : null}
    </div>
  );
}
