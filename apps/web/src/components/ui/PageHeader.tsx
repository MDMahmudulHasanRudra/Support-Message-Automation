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
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-[color:var(--color-foreground)]">
          {title}
        </h1>
        {description ? (
          <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
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
      <h2 className="text-sm font-semibold text-[color:var(--color-foreground)]">{title}</h2>
      {description ? (
        <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">{description}</p>
      ) : null}
    </div>
  );
}
