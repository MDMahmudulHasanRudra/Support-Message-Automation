export default function MessagesLoading() {
  return (
    <div className="animate-pulse">
      <div className="mb-6 h-8 w-48 rounded bg-zinc-200 dark:bg-zinc-800" />
      <div className="mb-4 h-10 w-full rounded bg-zinc-100 dark:bg-zinc-900" />
      <div className="space-y-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-10 w-full rounded bg-zinc-100 dark:bg-zinc-900" />
        ))}
      </div>
    </div>
  );
}
