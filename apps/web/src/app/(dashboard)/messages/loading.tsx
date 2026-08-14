import { TableSkeleton } from "@/components/ui";

export default function MessagesLoading() {
  return (
    <div>
      <div className="mb-7 h-8 w-48 animate-pulse rounded-[var(--radius-sm)] bg-[var(--color-neutral-bg)]" />
      <div className="mb-4 h-16 w-full animate-pulse rounded-[var(--radius-lg)] bg-[var(--color-neutral-bg)]" />
      <TableSkeleton rows={10} columns={12} />
    </div>
  );
}
