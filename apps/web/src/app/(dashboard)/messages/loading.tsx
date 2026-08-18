import { TableSkeleton } from "@/components/ui";

export default function MessagesLoading() {
  return (
    <div>
      <div className="mb-7 h-8 w-48 animate-shimmer rounded-[var(--radius-sm)]" />
      <div className="mb-4 h-16 w-full animate-shimmer rounded-[var(--radius-lg)]" />
      <TableSkeleton rows={10} columns={12} />
    </div>
  );
}
