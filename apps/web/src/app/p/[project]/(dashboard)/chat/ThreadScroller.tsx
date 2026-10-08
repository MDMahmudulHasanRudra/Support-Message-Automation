"use client";

import { ArrowDown } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Keeps a conversation pinned to its newest message, the way every chat client does and this one
 * did not.
 *
 * The thread rendered oldest-first inside a plain scroll container, so opening a conversation
 * showed the TOP of the loaded history. On anything with more than a screenful you landed on a
 * message from days ago and had to scroll down to find out what the customer actually said. For an
 * inbox whose whole job is answering the latest message, that was the wrong end.
 *
 * Two rules, and the second is what stops the fix becoming its own annoyance:
 *
 * 1. Opening a conversation jumps to the bottom, instantly and without animation. This is not an
 *    entrance worth watching — it is where the content starts, and a smooth scroll through three
 *    days of history would be motion for its own sake.
 * 2. New messages only pull you down IF you were already near the bottom. The layout refreshes
 *    every four seconds, and scrolling someone to the bottom while they are reading history would
 *    make old messages unreadable in a group that is busy. Read further up and the thread holds
 *    still, with a button offering the trip down.
 */

/** Close enough to the bottom that the reader is following the conversation rather than reading back. */
const NEAR_BOTTOM_PX = 120;

export function ThreadScroller({
  /** Changes when a message arrives: jump only if already following along. */
  latestEntryId,
  children,
}: {
  latestEntryId: string | null;
  children: React.ReactNode;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [showJump, setShowJump] = useState(false);
  // Whether the reader was at the bottom before this render. Read by the arrival effect below,
  // which must not itself depend on scroll state or it would re-run on every scroll event.
  const wasNearBottom = useRef(true);

  const scrollToBottom = useCallback((behavior: ScrollBehavior) => {
    const node = viewport.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior });
  }, []);

  const syncPosition = useCallback(() => {
    const node = viewport.current;
    if (!node) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    const near = distance <= NEAR_BOTTOM_PX;
    wasNearBottom.current = near;
    setShowJump(!near);
  }, []);

  // Mounting means a conversation was just opened, because the parent keys this component by
  // group id. Land on the newest message. "auto" rather than "smooth" on purpose: this is the
  // starting position, not a transition worth watching.
  //
  // That key is also what resets "showJump" and "wasNearBottom": remounting gives fresh state for
  // free, where setting them here would be exactly the cascading render the lint rule is about.
  useEffect(() => {
    scrollToBottom("auto");
  }, [scrollToBottom]);

  // A message arrived. Follow it only if the reader was already at the bottom.
  useEffect(() => {
    if (!latestEntryId) return;
    if (!wasNearBottom.current) return;
    scrollToBottom("auto");
  }, [latestEntryId, scrollToBottom]);

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={viewport}
        onScroll={syncPosition}
        className="h-full overflow-y-auto overscroll-contain bg-[var(--color-surface-sunken)]"
      >
        {children}
      </div>

      {/* Only while it would do something. A permanently visible control over the conversation is
          furniture; one that appears when you have scrolled away is an answer to a question you
          just asked. */}
      {showJump ? (
        <button
          type="button"
          onClick={() => scrollToBottom("smooth")}
          className="absolute bottom-4 left-1/2 flex -translate-x-1/2 cursor-pointer items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-[11px] font-medium text-[color:var(--color-foreground)] shadow-[var(--shadow-md)] transition-[transform,border-color] duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:border-[var(--color-border-strong)] active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
        >
          <ArrowDown className="size-3.5" aria-hidden />
          Jump to latest
        </button>
      ) : null}
    </div>
  );
}
