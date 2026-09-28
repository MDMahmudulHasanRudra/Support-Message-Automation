"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { MessageSquareText, Search, Settings2 } from "lucide-react";
import { recordSavedReplyUse } from "@/server/actions/savedReplies";

export interface SavedReplyOption {
  id: string;
  title: string;
  body: string;
}

/**
 * Picks a saved reply and drops it into the composer.
 *
 * It inserts rather than sends, always. A picker that sent on click is a one-tap path to putting
 * the wrong canned message in front of a customer, and the saved text is a starting point — the
 * last word on whether it fits this conversation belongs to the person reading it.
 *
 * A panel anchored above the composer rather than a modal: the conversation stays visible while
 * you choose, which is the whole basis for choosing correctly. A modal would cover the thing the
 * reply is about.
 */
export function SavedReplyPicker({
  replies,
  onInsert,
  onManage,
}: {
  replies: SavedReplyOption[];
  onInsert: (body: string) => void;
  onManage: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Clamped at read time rather than reset in an effect: filtering can shrink the list under a
  // selection that was valid a keystroke ago, and setting state from an effect to fix that costs
  // a second render pass on every character typed.
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return replies;
    return replies.filter((reply) => `${reply.title} ${reply.body}`.toLowerCase().includes(needle));
  }, [replies, query]);

  const activeIndex = Math.min(highlighted, Math.max(0, filtered.length - 1));

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();

    function onPointerDown(event: PointerEvent) {
      if (!panelRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function choose(reply: SavedReplyOption) {
    onInsert(reply.body);
    setOpen(false);
    setQuery("");
    // Counting the use must never be able to swallow the insert, which has already happened.
    void recordSavedReplyUse(reply.id).catch(() => {});
  }

  return (
    <div className="relative" ref={panelRef}>
      <button
        type="button"
        onClick={() => {
          setOpen((current) => !current);
          setHighlighted(0);
        }}
        aria-expanded={open}
        aria-haspopup="listbox"
        title="Saved replies"
        aria-label="Saved replies"
        className="flex size-10 cursor-pointer items-center justify-center rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] text-[color:var(--color-muted-foreground)] transition-[background-color,border-color,transform] duration-[var(--duration-fast)] hover:border-[var(--color-border-strong)] hover:text-[color:var(--color-foreground)] active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
      >
        <MessageSquareText className="size-4" aria-hidden />
      </button>

      {open ? (
        <div
          role="listbox"
          aria-label="Saved replies"
          className="absolute bottom-[calc(100%+0.5rem)] left-0 z-30 w-[min(26rem,calc(100vw-3rem))] overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] shadow-[var(--shadow-lg)]"
        >
          <div className="relative border-b border-[var(--color-border)] p-2">
            <Search
              className="pointer-events-none absolute left-4 top-1/2 size-3.5 -translate-y-1/2 text-[color:var(--color-muted-foreground)]"
              aria-hidden
            />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                // Back to the top on every keystroke: after filtering, "the third one" means a
                // different reply than it did before.
                setHighlighted(0);
              }}
              placeholder="Search saved replies"
              aria-label="Search saved replies"
              onKeyDown={(event) => {
                // Arrow-and-enter, because this is reached while typing. Having to move to the
                // mouse to pick the thing you opened with a keystroke defeats the point.
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setHighlighted((current) => Math.min(current + 1, filtered.length - 1));
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setHighlighted((current) => Math.max(current - 1, 0));
                } else if (event.key === "Enter" && filtered[activeIndex]) {
                  event.preventDefault();
                  choose(filtered[activeIndex]!);
                }
              }}
              className="h-8 w-full rounded-[var(--radius-sm)] bg-transparent pl-7 pr-2 text-[13px] text-[color:var(--color-foreground)] outline-none placeholder:text-[color:var(--color-muted-foreground)]"
            />
          </div>

          <div className="max-h-72 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="px-3 py-6 text-center text-[12px] leading-relaxed text-[color:var(--color-muted-foreground)]">
                {replies.length === 0
                  ? "No saved replies yet. Keep the sentences you retype every day here."
                  : `Nothing matches “${query}”.`}
              </p>
            ) : (
              <ul>
                {filtered.map((reply, index) => (
                  <li key={reply.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={index === activeIndex}
                      onMouseEnter={() => setHighlighted(index)}
                      onClick={() => choose(reply)}
                      className={`flex w-full cursor-pointer flex-col gap-0.5 border-b border-[var(--color-border)] px-3 py-2 text-left last:border-b-0 transition-colors duration-[var(--duration-fast)] ${
                        index === activeIndex ? "bg-[var(--color-neutral-bg)]" : ""
                      }`}
                    >
                      <span className="text-[12.5px] font-medium text-[color:var(--color-foreground)]">
                        {reply.title}
                      </span>
                      <span className="line-clamp-2 text-[11.5px] leading-relaxed text-[color:var(--color-muted-foreground)]">
                        {reply.body}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-3 py-1.5">
            <span className="text-[10.5px] text-[color:var(--color-muted-foreground)]">
              Inserts into the box — nothing is sent until you press send.
            </span>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onManage();
              }}
              className="flex shrink-0 cursor-pointer items-center gap-1 text-[10.5px] font-medium text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
            >
              <Settings2 className="size-3" aria-hidden />
              Manage
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
