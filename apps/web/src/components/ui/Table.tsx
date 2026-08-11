import type { ReactNode } from "react";

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
      <table className="w-full text-left text-sm">{children}</table>
    </div>
  );
}

export function Th({ children }: { children: ReactNode }) {
  return (
    <th className="border-b border-[var(--color-border)] bg-[var(--color-neutral-bg)] px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
      {children}
    </th>
  );
}

export function Td({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <td
      className={`border-b border-[var(--color-border)] px-4 py-3 text-[color:var(--color-foreground)] ${className}`}
    >
      {children}
    </td>
  );
}

export function TableSkeleton({ rows = 6, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--color-border)]">
      <div className="divide-y divide-[var(--color-border)]">
        {Array.from({ length: rows }).map((_, rowIndex) => (
          <div key={rowIndex} className="flex animate-pulse gap-4 px-4 py-3">
            {Array.from({ length: columns }).map((__, colIndex) => (
              <div key={colIndex} className="h-4 flex-1 rounded bg-[var(--color-neutral-bg)]" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
