"use client";

import { AlertTriangle, Inbox } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./Button";

export function EmptyState({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 p-10 text-center text-sm text-[color:var(--color-muted-foreground)]">
      <span className="text-[color:var(--color-border-strong)]">
        {icon ?? <Inbox className="size-6" aria-hidden />}
      </span>
      <p>{children}</p>
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
    <div className="flex flex-col items-center gap-3 p-10 text-center">
      <AlertTriangle className="size-6 text-[color:var(--color-danger)]" aria-hidden />
      <div>
        <p className="text-sm font-medium text-[color:var(--color-foreground)]">{title}</p>
        {description ? (
          <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">{description}</p>
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
