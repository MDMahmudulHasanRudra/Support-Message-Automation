import { Card, TableSkeleton } from "@/components/ui";

export default function OverviewLoading() {
  return (
    <div>
      <div className="mb-6 h-16 w-64 animate-shimmer rounded-[var(--radius-lg)]" />

      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, index) => (
          <div
            key={index}
            className="h-[86px] animate-shimmer rounded-[var(--radius-lg)] border border-[var(--color-border)]"
          />
        ))}
      </div>

      <Card className="mb-6">
        <div className="mb-3 h-4 w-40 animate-shimmer rounded" />
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="h-5 animate-shimmer rounded" />
          ))}
        </div>
      </Card>

      <Card>
        <div className="mb-3 h-4 w-40 animate-shimmer rounded" />
        <TableSkeleton rows={10} columns={5} />
      </Card>
    </div>
  );
}
