import { Card, TableSkeleton } from "@/components/ui";

/**
 * The loading fallback for every dashboard page that does not define its own.
 *
 * Two of seventy-five routes had one. Everywhere else a navigation showed the *previous* page,
 * frozen, until the server finished — and several of these pages run eight or more queries, so
 * that pause is long enough for someone to click again thinking the first click missed.
 *
 * Deliberately generic: it stands in for pages with very different layouts, so it shows the shape
 * every one of them shares — a title, a subtitle, and a body — rather than pretending to know the
 * grid. Pages whose layout is distinctive enough to be worth mirroring (overview, messages) keep
 * their own more specific skeleton, which Next prefers over this one.
 */
export default function DashboardLoading() {
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
