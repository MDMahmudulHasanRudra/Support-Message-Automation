import type { ReactNode } from "react";

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xs),var(--highlight-top)]">
      <table className="w-full border-collapse text-left text-sm [&_tbody_tr:hover]:bg-[var(--color-neutral-bg)]/70 [&_tbody_tr:last-child_td]:border-b-0 [&_tbody_tr]:transition-colors [&_tbody_tr]:duration-[var(--duration-fast)]">
        {children}
      </table>
    </div>
  );
}

export function Th({ children }: { children: ReactNode }) {
  return (
    // Sentence case, not shouted caps: the column names are read constantly and
    // the quieter treatment keeps the eye on the data underneath them.
    <th className="sticky top-0 z-[var(--z-sticky)] border-b border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-4 py-2.5 text-xs font-medium text-[color:var(--color-muted-foreground)]">
      {children}
    </th>
  );
}

export function Td({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <td
      className={`border-b border-[var(--color-border)] px-4 py-3 align-middle text-[color:var(--color-foreground)] ${className}`}
    >
      {children}
    </td>
  );
}

export function TableSkeleton({ rows = 6, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)]">
      <div className="divide-y divide-[var(--color-border)]">
        {Array.from({ length: rows }).map((_, rowIndex) => (
          <div key={rowIndex} className="flex gap-4 px-4 py-3.5">
            {Array.from({ length: columns }).map((__, colIndex) => (
              <div key={colIndex} className="h-4 flex-1 animate-shimmer rounded-[var(--radius-xs)]" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
