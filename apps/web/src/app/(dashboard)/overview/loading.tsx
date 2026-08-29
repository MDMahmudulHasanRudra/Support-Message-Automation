import { Card, TableSkeleton } from "@/components/ui";

/**
 * Mirrors overview/page.tsx's real grid — stat tiles, the metrics charts, the
 * module cards, then the activity table — so the skeleton hands over to the loaded
 * page without the layout jumping underneath the cursor.
 */
export default function OverviewLoading() {
  return (
    <div>
      <div className="mb-8 border-b border-[var(--color-border)] pb-6">
        <div className="h-7 w-40 animate-shimmer rounded-[var(--radius-sm)]" />
        <div className="mt-3 h-4 w-72 animate-shimmer rounded-[var(--radius-xs)]" />
      </div>

      <div className="mb-7 grid grid-cols-2 gap-3.5 sm:grid-cols-4">
        {Array.from({ length: 8 }).map((_, index) => (
          <div
            key={index}
            className="h-[92px] animate-shimmer rounded-[var(--radius-lg)] border border-[var(--color-border)]"
          />
        ))}
      </div>

      <div className="mb-7 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="h-[268px] animate-shimmer rounded-[var(--radius-xl)] border border-[var(--color-border)] lg:col-span-2" />
        <div className="h-[268px] animate-shimmer rounded-[var(--radius-xl)] border border-[var(--color-border)]" />
        <div className="h-[248px] animate-shimmer rounded-[var(--radius-xl)] border border-[var(--color-border)] lg:col-span-2" />
        <div className="h-[248px] animate-shimmer rounded-[var(--radius-xl)] border border-[var(--color-border)]" />
      </div>

      <div className="mb-7 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
        {Array.from({ length: 6 }).map((_, index) => (
          <div
            key={index}
            className="h-[186px] animate-shimmer rounded-[var(--radius-xl)] border border-[var(--color-border)]"
          />
        ))}
      </div>

      <Card>
        <div className="mb-4 h-4 w-40 animate-shimmer rounded-[var(--radius-xs)]" />
        <TableSkeleton rows={10} columns={5} />
      </Card>
    </div>
  );
}
