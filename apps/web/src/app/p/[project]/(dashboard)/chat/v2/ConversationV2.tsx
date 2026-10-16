"use client";

import { ArrowDown, Loader2, Search, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { encodeThreadCursor, mergeThreadPages, type OwnReactionState } from "@support-automation/shared";
import { Alert } from "@/components/ui";
import { useProjectRouter } from "@/components/ProjectLink";
import { cancelQueuedChatMessage, reactToChatMessage } from "@/server/actions/chat";
import { loadOlderChatMessages, refreshOwnReactions, searchChatThread } from "@/server/actions/chatThread";
import type { OtherAccountCopy, ThreadEntry } from "@/server/chatInbox";
import type { ConversationRef, ThreadSearchHit } from "@/server/chatThreadV2";
import { decideOnArrival, distanceFromBottom, NEAR_BOTTOM_PX, scrollTopAfterPrepend, shouldLoadOlder, type ScrollGeometry } from "@/lib/chatScroll";
import { formatDateTime } from "@/lib/date";
import type { SavedReplyOption } from "../SavedReplyPicker";
import { continues, dayFormat } from "../threadPresentation";
import { ComposerV2, type ReplyTarget } from "./ComposerV2";
import { GalleryLightbox, type GalleryImage } from "./GalleryLightbox";
import { MessageBubbleV2 } from "./MessageBubbleV2";

/**
 * One conversation in the v2 view (CHAT_UI_V2.md): the thread and the composer, sharing the reply
 * target, the search and the gallery.
 *
 * Data comes from three places and is merged into one list, one entry per id, ordered by
 * (timestampWa, id) — the same order every server query uses:
 *   1. the live window (the newest 80 + queued sends), re-rendered by the layout's 4 s refresh;
 *   2. stored messages that have since dropped OUT of that window as newer ones arrived — kept, so a
 *      busy group never opens a gap between the window and the pages loaded above it;
 *   3. older pages fetched on demand through `loadOlderChatMessages` (cursor paging).
 * Queued sends are only ever taken from the current live window: once WhatsApp echoes one it becomes
 * a stored message and the queued bubble must disappear, not linger from a stale copy.
 */

interface ThreadV2Context {
  searchOpen: boolean;
  toggleSearch: () => void;
}
const Context = createContext<ThreadV2Context | null>(null);

/** The header's search button. Rendered by the (server) page inside the header slot. */
export function ThreadSearchToggle() {
  const ctx = useContext(Context);
  if (!ctx) return null;
  return (
    <button
      type="button"
      onClick={ctx.toggleSearch}
      aria-pressed={ctx.searchOpen}
      aria-label="Search this conversation"
      title="Search this conversation"
      className={`flex size-8 items-center justify-center rounded-[var(--radius-md)] transition-colors hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] ${
        ctx.searchOpen ? "bg-[var(--color-neutral-bg)] text-[color:var(--color-foreground)]" : "text-[color:var(--color-muted-foreground)]"
      }`}
    >
      <Search className="size-4" aria-hidden />
    </button>
  );
}

function geometryOf(node: HTMLElement): ScrollGeometry {
  return { scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight };
}

const isStored = (e: ThreadEntry) => e.kind === "INCOMING" || e.kind === "OUTGOING";

export function ConversationV2({
  conversation,
  isGroup,
  header,
  belowThread,
  entries,
  hasMore,
  reviewedAt,
  mentionNames,
  accountLabel,
  accountPhone,
  canReply,
  disabledReason,
  savedReplies,
  otherCopies,
  contactHrefBase,
  draftId,
  emptyText,
}: {
  conversation: ConversationRef;
  isGroup: boolean;
  header: ReactNode;
  belowThread?: ReactNode;
  entries: ThreadEntry[];
  hasMore: boolean;
  reviewedAt: Date | null;
  mentionNames: Record<string, string>;
  accountLabel: string;
  accountPhone: string | null;
  canReply: boolean;
  disabledReason: string | null;
  savedReplies: SavedReplyOption[];
  otherCopies: OtherAccountCopy[];
  /** The conversation's own path; a sender's name opens `?contact=<id>` on it. Null = names are plain text. */
  contactHrefBase: string | null;
  draftId: string;
  emptyText: string;
}) {
  const router = useProjectRouter();
  const viewport = useRef<HTMLDivElement>(null);

  // ---- Data: live window + retained + older pages -----------------------------------------------
  // Every stored message the live window has shown stays, at its newest copy — updated while
  // rendering when the window changes (React's "adjust state on a prop change" pattern).
  const [retained, setRetained] = useState(() => ({ source: entries, map: new Map(entries.filter(isStored).map((e) => [e.id, e])) }));
  if (retained.source !== entries) {
    const map = new Map(retained.map);
    for (const e of entries) if (isStored(e)) map.set(e.id, e);
    setRetained({ source: entries, map });
  }
  const [older, setOlder] = useState<ThreadEntry[]>([]);
  const [olderNames, setOlderNames] = useState<Record<string, string>>({});
  const [hasMoreOlder, setHasMoreOlder] = useState(hasMore);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [reactionPatch, setReactionPatch] = useState<Record<string, OwnReactionState>>({});
  const [overlays, setOverlays] = useState<Record<string, string>>({});

  const merged = useMemo(() => {
    const live = new Set(entries.map((e) => e.id));
    const list = mergeThreadPages(older, [...retained.map.values()], entries);
    return list.map((e) => (!live.has(e.id) && reactionPatch[e.id] ? { ...e, ownReaction: reactionPatch[e.id] } : e));
  }, [entries, older, retained, reactionPatch]);

  const names = useMemo(() => ({ ...olderNames, ...mentionNames }), [olderNames, mentionNames]);
  const oldestStored = merged.find(isStored) ?? null;
  const cursor = oldestStored ? encodeThreadCursor({ at: oldestStored.at.getTime(), id: oldestStored.id }) : null;

  // ---- Unread divider: fixed for this visit, from when it was last opened BEFORE now ------------
  const [firstUnreadId] = useState<string | null>(() => {
    if (!reviewedAt) return null;
    const since = new Date(reviewedAt).getTime();
    return entries.find((e) => e.kind === "INCOMING" && !e.isTeamMember && e.at.getTime() > since)?.id ?? null;
  });

  // ---- Scrolling ------------------------------------------------------------------------------
  const programmatic = useRef(false);
  const [atBottom, setAtBottom] = useState(true);
  const lastGeometry = useRef<ScrollGeometry | null>(null);
  const prepend = useRef<ScrollGeometry | null>(null);
  const pendingJump = useRef<string | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [seenUpTo, setSeenUpTo] = useState<number>(() => entries.at(-1)?.at.getTime() ?? 0);
  const latestId = merged.at(-1)?.id ?? null;
  const previousLatest = useRef<string | null>(null);

  const setScrollTop = useCallback((top: number) => {
    const node = viewport.current;
    if (!node) return;
    programmatic.current = true;
    node.scrollTop = top;
  }, []);

  const scrollToBottom = useCallback(
    (smooth = false) => {
      const node = viewport.current;
      if (!node) return;
      programmatic.current = true;
      node.scrollTo({ top: node.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    },
    [],
  );

  // ---- The on-screen keyboard ---------------------------------------------------------------------
  // On Android Chrome and iOS Safari the keyboard shrinks only the VISUAL viewport: `100dvh`, which the
  // chat layout is pinned to, does not move, so the composer would sit under the keys. On a phone this
  // publishes the visual viewport's height as `--chat-dvh` (which the layout uses, falling back to
  // `100dvh` — so v1, and every other page, never sees it) and keeps a reader who was at the newest
  // message there. Not while pinch-zoomed, when the visual viewport is smaller by design.
  const stickToBottom = useRef(true);
  useEffect(() => {
    stickToBottom.current = atBottom;
  }, [atBottom]);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const phone = window.matchMedia("(max-width: 767px)");
    const root = document.documentElement;
    const fit = () => {
      if (!phone.matches || vv.scale > 1.01) {
        root.style.removeProperty("--chat-dvh");
        return;
      }
      root.style.setProperty("--chat-dvh", `${Math.round(vv.height)}px`);
      // iOS scrolls the page to reveal the caret; the pinned layout starts at the top.
      if (vv.offsetTop > 0) window.scrollTo({ top: 0 });
      if (stickToBottom.current) requestAnimationFrame(() => viewport.current?.scrollTo({ top: viewport.current.scrollHeight }));
    };
    fit();
    vv.addEventListener("resize", fit);
    phone.addEventListener("change", fit);
    return () => {
      vv.removeEventListener("resize", fit);
      phone.removeEventListener("change", fit);
      root.style.removeProperty("--chat-dvh");
    };
  }, []);

  // After every render that changed the list: keep the reader's place, follow, or jump.
  useLayoutEffect(() => {
    const node = viewport.current;
    if (!node) return;
    if (pendingJump.current) {
      const target = document.getElementById(`msg-${pendingJump.current}`);
      if (target) {
        programmatic.current = true;
        target.scrollIntoView({ block: "center" });
        pendingJump.current = null;
        prepend.current = null;
      }
    } else if (prepend.current) {
      setScrollTop(scrollTopAfterPrepend(prepend.current, node.scrollHeight));
      prepend.current = null;
    }
    if (latestId !== previousLatest.current) {
      const first = previousLatest.current === null;
      previousLatest.current = latestId;
      const newest = merged.at(-1);
      const own = newest ? newest.kind === "QUEUED" || newest.kind === "OUTGOING" : false;
      const before = lastGeometry.current ?? geometryOf(node);
      if (first || decideOnArrival(own, before) === "bottom") scrollToBottom();
    }
    lastGeometry.current = geometryOf(node);
  }, [merged, latestId, scrollToBottom, setScrollTop]);

  const loadOlder = useCallback(
    async (untilMessageId?: string) => {
      if (loadingOlder || !cursor) return false;
      const node = viewport.current;
      setLoadingOlder(true);
      try {
        const page = await loadOlderChatMessages(conversation, cursor, untilMessageId ?? null);
        if ("error" in page) {
          setNotice(page.error);
          return false;
        }
        if (node && !untilMessageId) prepend.current = geometryOf(node);
        if (untilMessageId) pendingJump.current = untilMessageId;
        setOlder((list) => mergeThreadPages(page.entries, list));
        setOlderNames((n) => ({ ...page.mentionNames, ...n }));
        setHasMoreOlder(page.hasMore);
        return true;
      } finally {
        setLoadingOlder(false);
      }
    },
    [conversation, cursor, loadingOlder],
  );

  function onScroll() {
    const node = viewport.current;
    if (!node) return;
    const geometry = geometryOf(node);
    lastGeometry.current = geometry;
    const near = distanceFromBottom(geometry) <= NEAR_BOTTOM_PX;
    setAtBottom(near);
    if (near && latestId) setSeenUpTo(merged.at(-1)!.at.getTime());
    const userScroll = !programmatic.current;
    programmatic.current = false;
    if (shouldLoadOlder({ userScroll, geometry, hasMore: hasMoreOlder, loading: loadingOlder })) void loadOlder();
  }

  const unseen = merged.filter((e) => e.kind === "INCOMING" && e.at.getTime() > seenUpTo).length;

  // ---- Jump to a message (quote or search hit) --------------------------------------------------
  const jumpTo = useCallback(
    async (messageId: string) => {
      const flash = () => {
        setHighlight(messageId);
        setTimeout(() => setHighlight((h) => (h === messageId ? null : h)), 2200);
      };
      if (merged.some((e) => e.id === messageId)) {
        const target = document.getElementById(`msg-${messageId}`);
        if (target) {
          programmatic.current = true;
          target.scrollIntoView({ block: "center", behavior: "smooth" });
        }
        flash();
        return;
      }
      if (!hasMoreOlder) {
        setNotice("That message is not stored in this conversation.");
        return;
      }
      if (await loadOlder(messageId)) flash();
    },
    [merged, hasMoreOlder, loadOlder],
  );

  // ---- Search ----------------------------------------------------------------------------------
  const [searchOpen, setSearchOpen] = useState(false);
  const [term, setTerm] = useState("");
  const [hits, setHits] = useState<{ term: string; list: ThreadSearchHit[] } | null>(null);
  const [searching, setSearching] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toggleSearch = useCallback(() => setSearchOpen((v) => !v), []);

  function onSearchInput(value: string) {
    setTerm(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (value.trim().length < 2) {
      setHits(null);
      return;
    }
    searchTimer.current = setTimeout(async () => {
      setSearching(true);
      const result = await searchChatThread(conversation, value);
      setSearching(false);
      if ("error" in result) setNotice(result.error);
      // Stored WITH the term it answered, so a slow answer never lands under a newer term.
      else setHits({ term: value, list: result.hits });
    }, 300);
  }

  // ---- Reactions ---------------------------------------------------------------------------------
  const live = useMemo(() => new Set(entries.map((e) => e.id)), [entries]);
  const react = useCallback(
    async (entry: ThreadEntry, emoji: string) => {
      setOverlays((o) => ({ ...o, [entry.id]: emoji }));
      const result = await reactToChatMessage(entry.id, emoji);
      if (result.error) {
        setOverlays((o) => {
          const next = { ...o };
          delete next[entry.id];
          return next;
        });
        setNotice(result.error);
        return;
      }
      // The live window picks the worker's answer up on its own refresh. A message from an older
      // page is asked about directly, a few times, until the worker has settled it.
      if (live.has(entry.id)) return;
      for (let attempt = 0; attempt < 12; attempt++) {
        await new Promise((r) => setTimeout(r, 2500));
        const states = await refreshOwnReactions(conversation, [entry.id]);
        const state = states[entry.id];
        if (state) setReactionPatch((p) => ({ ...p, [entry.id]: state }));
        if (state && !state.pending) break;
      }
    },
    [conversation, live],
  );

  // An overlay is only a bridge until the server's own state names that emoji.
  const effectiveOverlays = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [id, emoji] of Object.entries(overlays)) {
      const s = merged.find((e) => e.id === id)?.ownReaction;
      if (s && (s.pending?.emoji === emoji || s.confirmed?.emoji === emoji || s.failed?.emoji === emoji)) continue;
      out[id] = emoji;
    }
    return out;
  }, [overlays, merged]);

  // ---- Reply, resend, cancel, gallery -------------------------------------------------------------
  const [reply, setReply] = useState<ReplyTarget | null>(null);
  const [insertRequest, setInsertRequest] = useState<{ text: string; nonce: number } | null>(null);
  const images: GalleryImage[] = useMemo(
    () => merged.filter((e) => e.media?.type === "IMAGE" && e.media.status === "STORED").map((e) => ({ mediaId: e.media!.id, alt: `Image ${formatDateTime(e.at)}` })),
    [merged],
  );
  const [galleryIndex, setGalleryIndex] = useState<number | null>(null);

  const contactHref = useCallback(
    (key: string) => (contactHrefBase ? `${contactHrefBase}?contact=${encodeURIComponent(key)}` : null),
    [contactHrefBase],
  );

  // ---- Rows ------------------------------------------------------------------------------------
  const rows = merged.map((entry, index) => {
    const previous = index === 0 ? null : merged[index - 1]!;
    const next = index === merged.length - 1 ? null : merged[index + 1]!;
    const day = dayFormat.format(entry.at);
    const showDivider = !previous || dayFormat.format(previous.at) !== day;
    return {
      entry,
      day,
      showDivider,
      startsRun: showDivider || !previous || !continues(previous, entry) || entry.id === firstUnreadId,
      endsRun: !next || dayFormat.format(next.at) !== day || !continues(entry, next) || next.id === firstUnreadId,
    };
  });

  return (
    <Context.Provider value={{ searchOpen, toggleSearch }}>
      <div className="flex min-w-0 flex-1 flex-col">
        {header}

        {searchOpen ? (
          <div className="relative shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 sm:px-6">
            <label className="flex items-center gap-2">
              <Search className="size-3.5 shrink-0 text-[color:var(--color-muted-foreground)]" aria-hidden />
              <span className="sr-only">Search this conversation</span>
              <input
                autoFocus
                value={term}
                onChange={(e) => onSearchInput(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setSearchOpen(false)}
                placeholder="Search this conversation's stored messages…"
                className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-[color:var(--color-subtle-foreground)]"
              />
              {searching ? <Loader2 className="size-3.5 animate-spin text-[color:var(--color-muted-foreground)]" aria-hidden /> : null}
              <button type="button" onClick={() => setSearchOpen(false)} aria-label="Close search" className="rounded-[var(--radius-sm)] p-1 text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-neutral-bg)]">
                <X className="size-3.5" aria-hidden />
              </button>
            </label>
            {hits && hits.term === term ? (
              <ul className="absolute inset-x-0 top-full z-20 max-h-72 overflow-y-auto border-b border-[var(--color-border)] bg-[var(--color-surface-raised)] shadow-[var(--shadow-md)]" aria-label="Matching messages">
                {hits.list.length === 0 ? (
                  <li className="px-4 py-3 text-[12px] text-[color:var(--color-muted-foreground)] sm:px-6">No stored message here contains “{term}”.</li>
                ) : (
                  hits.list.map((hit) => (
                    <li key={hit.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setSearchOpen(false);
                          void jumpTo(hit.id);
                        }}
                        className="block w-full px-4 py-2 text-left hover:bg-[var(--color-neutral-bg)] focus-visible:bg-[var(--color-neutral-bg)] focus-visible:outline-none sm:px-6"
                      >
                        <span className="block text-[10.5px] text-[color:var(--color-muted-foreground)]">
                          {hit.outgoing ? "Sent" : "Received"} · {formatDateTime(new Date(hit.at))}
                        </span>
                        <span className="line-clamp-2 text-[12.5px]" dir="auto">
                          {hit.snippet}
                        </span>
                      </button>
                    </li>
                  ))
                )}
              </ul>
            ) : null}
          </div>
        ) : null}

        {notice ? (
          <div className="shrink-0 px-4 pt-2 sm:px-6">
            <Alert tone="warning">
              <span className="flex items-start justify-between gap-2">
                <span>{notice}</span>
                <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss" className="shrink-0 opacity-70 hover:opacity-100">
                  <X className="size-3.5" aria-hidden />
                </button>
              </span>
            </Alert>
          </div>
        ) : null}

        <div className="relative min-h-0 flex-1">
          <div ref={viewport} onScroll={onScroll} className="h-full overflow-y-auto overscroll-contain bg-[var(--color-surface-sunken)]" role="log" aria-live="polite" aria-relevant="additions">
            <div className="flex flex-col gap-[3px] px-4 py-4 max-sm:px-2.5 sm:px-6">
              {merged.length ? (
                <div className="mb-2 flex justify-center">
                  {hasMoreOlder ? (
                    <button
                      type="button"
                      onClick={() => void loadOlder()}
                      disabled={loadingOlder}
                      className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1 text-[11px] font-medium text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)] disabled:opacity-60"
                    >
                      {loadingOlder ? <Loader2 className="size-3 animate-spin" aria-hidden /> : null}
                      {loadingOlder ? "Loading earlier messages…" : "Load earlier messages"}
                    </button>
                  ) : (
                    <p className="text-[11px] text-[color:var(--color-subtle-foreground)]">Start of the stored history — messages from before monitoring began were not recorded.</p>
                  )}
                </div>
              ) : (
                <div className="flex h-full items-center justify-center px-6 py-12">
                  <p className="max-w-sm text-center text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">{emptyText}</p>
                </div>
              )}

              {rows.map(({ entry, day, showDivider, startsRun, endsRun }) => (
                <div key={entry.id} className={startsRun && !showDivider ? "mt-2.5" : undefined}>
                  {showDivider ? (
                    <div className="my-3 flex items-center gap-3" role="separator" aria-label={day}>
                      <span className="h-px flex-1 bg-[var(--color-border)]" aria-hidden />
                      <span className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1 text-[11px] font-medium text-[color:var(--color-muted-foreground)] shadow-[var(--shadow-xs)]">{day}</span>
                      <span className="h-px flex-1 bg-[var(--color-border)]" aria-hidden />
                    </div>
                  ) : null}
                  {entry.id === firstUnreadId ? (
                    <div className="my-3 flex items-center gap-3" role="separator" aria-label="New messages since you last opened this conversation">
                      <span className="h-px flex-1 bg-[var(--color-accent)]/50" aria-hidden />
                      <span className="rounded-full bg-[var(--color-accent)] px-2.5 py-0.5 text-[10px] font-semibold text-[var(--color-on-accent,white)]">New since you last looked</span>
                      <span className="h-px flex-1 bg-[var(--color-accent)]/50" aria-hidden />
                    </div>
                  ) : null}
                  {entry.kind === "SYSTEM" ? (
                    <p className="my-1 text-center text-[11px] italic text-[color:var(--color-subtle-foreground)]">{entry.body}</p>
                  ) : (
                    <MessageBubbleV2
                      entry={entry}
                      startsRun={startsRun}
                      endsRun={endsRun}
                      isGroup={isGroup}
                      accountLabel={accountLabel}
                      mentionNames={names}
                      contactHref={contactHref}
                      highlighted={highlight === entry.id}
                      canReply={canReply && !disabledReason}
                      reactionOverlay={effectiveOverlays[entry.id] ?? null}
                      onReply={(e) =>
                        setReply({
                          id: e.id,
                          author: e.kind === "OUTGOING" ? "You" : (e.sender?.label ?? e.senderName ?? "this message"),
                          preview: e.body.slice(0, 200),
                        })
                      }
                      onReact={(e, emoji) => void react(e, emoji)}
                      onJumpTo={(id) => void jumpTo(id)}
                      onOpenImage={(mediaId) => {
                        const index = images.findIndex((img) => img.mediaId === mediaId);
                        setGalleryIndex(index >= 0 ? index : null);
                      }}
                      onResend={(text) => setInsertRequest({ text, nonce: Date.now() })}
                      onCancelQueued={async (outboundId) => {
                        await cancelQueuedChatMessage(outboundId);
                        router.refresh();
                      }}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>

          {!atBottom ? (
              <button
                type="button"
                onClick={() => scrollToBottom(true)}
                // A pill in the middle with a mouse; on a phone a round button at the right edge, where a
                // thumb rests — wide only when there is something new to name.
                className={`absolute flex cursor-pointer items-center justify-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-raised)] text-[11px] font-medium text-[color:var(--color-foreground)] shadow-[var(--shadow-md)] transition-transform hover:border-[var(--color-border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] active:scale-95 animate-scale-in bottom-4 left-1/2 -translate-x-1/2 px-3 py-1.5 max-sm:bottom-3 max-sm:left-auto max-sm:right-3 max-sm:translate-x-0 ${
                  unseen > 0 ? "max-sm:h-10 max-sm:px-3.5" : "max-sm:size-11 max-sm:p-0"
                }`}
              >
                <ArrowDown className="size-3.5 max-sm:size-4" aria-hidden />
                <span className={unseen > 0 ? "" : "max-sm:sr-only"}>{unseen > 0 ? `${unseen} new ${unseen === 1 ? "message" : "messages"}` : "Jump to latest"}</span>
              </button>
          ) : null}
        </div>

        {belowThread}
        <ComposerV2
          conversation={conversation}
          draftId={draftId}
          accountLabel={accountLabel}
          accountPhone={accountPhone}
          disabledReason={disabledReason}
          savedReplies={savedReplies}
          otherCopies={otherCopies}
          isGroup={isGroup}
          replyTarget={reply}
          onClearReply={() => setReply(null)}
          insertRequest={insertRequest}
          onSent={() => scrollToBottom()}
        />
      </div>

      {galleryIndex !== null && images.length ? (
        <GalleryLightbox images={images} index={galleryIndex} onIndex={setGalleryIndex} onClose={() => setGalleryIndex(null)} />
      ) : null}
    </Context.Provider>
  );
}
