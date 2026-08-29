"use client";

import { AlertTriangle, Inbox } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./Button";

export function EmptyState({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-4 px-6 py-14 text-center">
      <span className="flex size-11 items-center justify-center rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-sunken)] text-[color:var(--color-subtle-foreground)] shadow-[var(--shadow-xs),var(--highlight-top)]">
        {icon ?? <Inbox className="size-5" aria-hidden />}
      </span>
      <p className="max-w-sm text-sm leading-relaxed text-[color:var(--color-muted-foreground)]">
        {children}
      </p>
    </div>
  );
}

export function ErrorState({
  title = "Something went wrong.",
  description,
  onRetry,
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-4 px-6 py-14 text-center">
      <span className="flex size-11 items-center justify-center rounded-[var(--radius-lg)] border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] text-[color:var(--color-danger)]">
        <AlertTriangle className="size-5" aria-hidden />
      </span>
      <div>
        <p className="text-sm font-medium text-[color:var(--color-foreground)]">{title}</p>
        {description ? (
          <p className="mt-1.5 max-w-sm text-xs leading-relaxed text-[color:var(--color-muted-foreground)]">
            {description}
          </p>
        ) : null}
      </div>
      {onRetry ? (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}
