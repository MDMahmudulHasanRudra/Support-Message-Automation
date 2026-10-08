/**
 * The chat inbox's own loading fallback.
 *
 * The group-level skeleton stands in for a title, a subtitle and a table, which is the shape
 * almost every page here shares — and precisely not this one. Chat is a full-height two-pane
 * frame, so falling back to the generic one meant the layout visibly rebuilt itself on arrival:
 * a page-shaped block, then a sudden reflow into two columns. Mirroring the real frame is what
 * makes the load read as the page arriving rather than the page changing its mind.
 *
 * The right pane holds a few bubbles alternating sides rather than more list rows. It is the only
 * part of the skeleton that says "this is a conversation", and a loading state that does not
 * suggest what is coming is just a grey rectangle.
 */
export default function ChatLoading() {
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className="flex h-[calc(100dvh-6.75rem)] min-h-[30rem] overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xs),var(--highlight-top)] sm:h-[calc(100dvh-8.25rem)]"
    >
      <span className="sr-only">Loading conversations…</span>

      <aside className="hidden w-[19rem] shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface-sunken)] md:flex">
        <div className="shrink-0 border-b border-[var(--color-border)] p-3">
          <div className="h-9 w-full animate-shimmer rounded-[var(--radius-md)]" />
          <div className="mt-2 flex gap-1.5">
            <div className="h-6 w-14 animate-shimmer rounded-full" />
            <div className="h-6 w-20 animate-shimmer rounded-full" />
            <div className="h-6 w-16 animate-shimmer rounded-full" />
          </div>
        </div>

        <div className="flex-1 overflow-hidden">
          {Array.from({ length: 9 }).map((_, index) => (
            <div key={index} className="flex gap-3 border-b border-[var(--color-border)] px-3.5 py-3">
              <div className="size-9 shrink-0 animate-shimmer rounded-[var(--radius-lg)]" />
              <div className="min-w-0 flex-1">
                {/* Widths vary per row. A column of identical bars reads as a loading graphic;
                    uneven ones read as names and messages that have not arrived yet. */}
                <div
                  className="h-3 animate-shimmer rounded-[var(--radius-xs)]"
                  style={{ width: `${52 + ((index * 13) % 34)}%` }}
                />
                <div
                  className="mt-2 h-2.5 animate-shimmer rounded-[var(--radius-xs)]"
                  style={{ width: `${64 + ((index * 17) % 30)}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-3 border-b border-[var(--color-border)] px-5 py-3.5">
          <div className="size-9 shrink-0 animate-shimmer rounded-[var(--radius-lg)]" />
          <div className="min-w-0 flex-1">
            <div className="h-3.5 w-48 max-w-full animate-shimmer rounded-[var(--radius-xs)]" />
            <div className="mt-2 h-2.5 w-32 max-w-full animate-shimmer rounded-[var(--radius-xs)]" />
          </div>
        </div>

        <div className="flex-1 space-y-3 p-6">
          {[62, 44, 70, 38, 55].map((width, index) => (
            <div key={width} className={`flex ${index % 2 === 1 ? "justify-end" : "justify-start"}`}>
              <div
                className={`h-12 animate-shimmer ${
                  index % 2 === 1
                    ? "rounded-l-[var(--radius-lg)] rounded-tr-[var(--radius-lg)] rounded-br-[var(--radius-xs)]"
                    : "rounded-r-[var(--radius-lg)] rounded-tl-[var(--radius-lg)] rounded-bl-[var(--radius-xs)]"
                }`}
                style={{ width: `${width}%`, maxWidth: "38rem" }}
              />
            </div>
          ))}
        </div>

        <div className="shrink-0 border-t border-[var(--color-border)] p-3 sm:px-6 sm:py-4">
          <div className="h-10 w-full animate-shimmer rounded-[var(--radius-md)]" />
        </div>
      </div>
    </div>
  );
}
