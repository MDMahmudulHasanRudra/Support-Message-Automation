import { Card, TableSkeleton } from "@/components/ui";

/**
 * The loading fallback for every Main Admin Portal page, mirroring the dashboard's
 * (`p/[project]/(dashboard)/loading.tsx`): without one a navigation left the previous page frozen
 * until the server finished. Deliberately generic — a title, a subtitle and a body — because it
 * stands in for pages with very different layouts.
 */
export default function AdminLoading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>

      <div className="mb-8 border-b border-[var(--color-border)] pb-6">
        <div className="h-7 w-52 animate-shimmer rounded-[var(--radius-sm)]" />
        <div className="mt-3 h-4 w-80 max-w-full animate-shimmer rounded-[var(--radius-xs)]" />
      </div>

      <Card>
        <div className="mb-4 h-4 w-40 animate-shimmer rounded-[var(--radius-xs)]" />
        <TableSkeleton rows={8} columns={4} />
      </Card>
    </div>
  );
}
