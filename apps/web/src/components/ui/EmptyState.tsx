"use client";

import { AlertTriangle, Inbox } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./Button";

export function EmptyState({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 p-12 text-center text-sm text-[color:var(--color-muted-foreground)]">
      <span className="flex size-12 items-center justify-center rounded-full bg-[var(--color-neutral-bg)] text-[color:var(--color-muted-foreground)]">
        {icon ?? <Inbox className="size-5" aria-hidden />}
      </span>
      <p className="max-w-sm">{children}</p>
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
    <div className="flex flex-col items-center gap-3 p-12 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-[var(--color-danger-bg)] text-[color:var(--color-danger)]">
        <AlertTriangle className="size-5" aria-hidden />
      </span>
      <div>
        <p className="text-sm font-medium text-[color:var(--color-foreground)]">{title}</p>
        {description ? (
          <p className="mt-1 max-w-sm text-xs text-[color:var(--color-muted-foreground)]">{description}</p>
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
