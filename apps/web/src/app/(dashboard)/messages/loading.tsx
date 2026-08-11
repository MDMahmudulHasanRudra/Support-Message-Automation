import { TableSkeleton } from "@/components/ui";

export default function MessagesLoading() {
  return (
    <div>
      <div className="mb-6 h-8 w-48 animate-pulse rounded bg-[var(--color-neutral-bg)]" />
      <div className="mb-4 h-16 w-full animate-pulse rounded-lg bg-[var(--color-neutral-bg)]" />
      <TableSkeleton rows={10} columns={8} />
    </div>
  );
}
