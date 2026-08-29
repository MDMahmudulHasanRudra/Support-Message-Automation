import Link from "next/link";
import { BrandMark } from "@/components/ui";

/**
 * Root 404. Sits outside the dashboard layout (no session, no sidebar), so it
 * carries its own centering and its own way back — a dead end with no exit is
 * the failure mode this replaces.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 px-6 py-16 text-center">
      <BrandMark className="size-10" />

      <div>
        <p className="tabular text-[13px] font-medium text-[color:var(--color-muted-foreground)]">404</p>
        <h1 className="mt-2 text-[26px] font-semibold tracking-[-0.025em] text-[color:var(--color-foreground)]">
          That page does not exist
        </h1>
        <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-[color:var(--color-muted-foreground)]">
          The link may be out of date, or the record it pointed at was removed.
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/overview"
          className="inline-flex h-9.5 items-center rounded-[var(--radius-md)] bg-[var(--color-primary)] px-4 text-sm font-medium text-[var(--color-on-primary)] shadow-[var(--shadow-sm)] transition-colors duration-[var(--duration-fast)] hover:bg-[var(--color-primary-hover)]"
        >
          Back to Overview
        </Link>
        <Link
          href="/messages"
          className="inline-flex h-9.5 items-center rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-4 text-sm font-medium text-[color:var(--color-foreground)] shadow-[var(--shadow-xs),var(--highlight-top)] transition-colors duration-[var(--duration-fast)] hover:bg-[var(--color-neutral-bg)]"
        >
          All Messages
        </Link>
      </div>
    </main>
  );
}
