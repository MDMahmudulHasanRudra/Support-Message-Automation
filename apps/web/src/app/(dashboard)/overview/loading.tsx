import { Card, TableSkeleton } from "@/components/ui";

export default function OverviewLoading() {
  return (
    <div>
      <div className="mb-6 h-16 w-64 animate-pulse rounded-lg bg-[var(--color-neutral-bg)]" />

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-5">
        {Array.from({ length: 5 }).map((_, index) => (
          <div
            key={index}
            className="h-[86px] animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-neutral-bg)]"
          />
        ))}
      </div>

      <Card className="mb-6">
        <div className="mb-3 h-4 w-40 animate-pulse rounded bg-[var(--color-neutral-bg)]" />
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="h-5 animate-pulse rounded bg-[var(--color-neutral-bg)]" />
          ))}
        </div>
      </Card>

      <Card>
        <div className="mb-3 h-4 w-40 animate-pulse rounded bg-[var(--color-neutral-bg)]" />
        <TableSkeleton rows={10} columns={5} />
      </Card>
    </div>
  );
}
