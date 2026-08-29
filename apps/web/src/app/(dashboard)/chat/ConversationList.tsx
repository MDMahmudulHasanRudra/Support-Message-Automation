"use client";

import { Inbox, Search, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useState } from "react";
import type { ConversationSummary } from "@/server/chatInbox";

function relativeTime(value: Date | null): string {
  if (!value) return "";
  const diffMs = Date.now() - new Date(value).getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Dhaka", month: "short", day: "numeric" }).format(
    new Date(value),
  );
}

/**
 * The left pane, rendered once by the chat layout so it keeps its scroll position as you
 * move between conversations.
 *
 * Filtering is local rather than a server round-trip: the layout already loaded every
 * active group (name and last line only), so matching in the browser is instant and costs
 * nothing. The active conversation comes from the pathname, since a layout cannot read
 * route params.
 */
export function ConversationList({ conversations }: { conversations: ConversationSummary[] }) {
  const pathname = usePathname();
  const [query, setQuery] = useState("");
  const [waitingOnly, setWaitingOnly] = useState(false);

  const activeGroupId = pathname.startsWith("/chat/") ? pathname.slice("/chat/".length) : undefined;

  const waitingCount = useMemo(
    () => conversations.filter((conversation) => conversation.awaitingReply).length,
    [conversations],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return conversations.filter((conversation) => {
      if (waitingOnly && !conversation.awaitingReply) return false;
      if (!needle) return true;
      const haystack = `${conversation.name} ${conversation.accountLabel} ${conversation.lastMessagePreview ?? ""}`;
      return haystack.toLowerCase().includes(needle);
    });
  }, [conversations, query, waitingOnly]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-[var(--color-border)] p-3">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[color:var(--color-muted-foreground)]"
            aria-hidden
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search conversations"
            aria-label="Search conversations"
            className="h-9 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] pl-8 pr-8 text-[13px] text-[color:var(--color-foreground)] outline-none transition-[border-color,box-shadow] duration-[var(--duration-fast)] placeholder:text-[color:var(--color-muted-foreground)] focus-visible:border-[var(--color-primary)] focus-visible:ring-[3px] focus-visible:ring-[var(--color-primary)]/12"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 flex size-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded-[var(--radius-xs)] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          ) : null}
        </div>

        {/* The one number that matters in a support inbox: how many customers are still
            waiting. Doubles as the filter, because seeing the count and then hunting for the
            rows it refers to is the obvious next thing anyone would want. */}
        {waitingCount > 0 ? (
          <button
            type="button"
            onClick={() => setWaitingOnly((current) => !current)}
            aria-pressed={waitingOnly}
            className={`mt-2 flex w-full cursor-pointer items-center gap-2 rounded-[var(--radius-md)] border px-2.5 py-1.5 text-left text-[11px] font-medium transition-colors duration-[var(--duration-fast)] ${
              waitingOnly
                ? "border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] text-[color:var(--color-warning-fg)]"
                : "border-[var(--color-border)] bg-[var(--color-surface)] text-[color:var(--color-muted-foreground)] hover:border-[var(--color-border-strong)]"
            }`}
          >
            <Inbox className="size-3.5 shrink-0" aria-hidden />
            <span className="tabular">{waitingCount}</span>
            <span>awaiting a reply</span>
            <span className="ml-auto text-[10px] opacity-70">{waitingOnly ? "Show all" : "Show only"}</span>
          </button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <p className="px-4 py-10 text-center text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
            {conversations.length === 0
              ? "No groups yet. Connect an account and run a group sync to populate this list."
              : waitingOnly
                ? "Nothing is waiting on a reply."
                : `No group matches “${query}”.`}
          </p>
        ) : (
          <ul>
            {filtered.map((conversation) => {
              const active = conversation.id === activeGroupId;
              return (
                <li key={conversation.id}>
                  <Link
                    href={`/chat/${conversation.id}`}
                    aria-current={active ? "page" : undefined}
                    className={`flex gap-3 border-b border-[var(--color-border)] px-3.5 py-3 transition-colors duration-[var(--duration-fast)] ${
                      active ? "bg-[var(--color-neutral-bg)]" : "hover:bg-[var(--color-neutral-bg)]/60"
                    }`}
                  >
                    <span className="relative mt-0.5 shrink-0">
                      <span
                        aria-hidden
                        className="flex size-9 items-center justify-center rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-sunken)] text-[11px] font-semibold uppercase text-[color:var(--color-muted-foreground)]"
                      >
                        {conversation.name.slice(0, 2)}
                      </span>
                      {conversation.awaitingReply ? (
                        <span
                          title="A customer is waiting for a reply"
                          className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-[var(--color-warning)] shadow-[0_0_0_2px_var(--color-surface-sunken)]"
                        />
                      ) : null}
                    </span>

                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-[13px] font-medium text-[color:var(--color-foreground)]">
                          {conversation.name}
                        </span>
                        <span className="tabular shrink-0 text-[10px] text-[color:var(--color-muted-foreground)]">
                          {relativeTime(conversation.lastMessageAt)}
                        </span>
                      </span>

                      <span className="mt-0.5 flex items-center gap-1.5">
                        <span className="min-w-0 flex-1 truncate text-[12px] text-[color:var(--color-muted-foreground)]">
                          {conversation.lastMessagePreview ? (
                            <>
                              {conversation.lastMessageOutgoing ? (
                                <span className="text-[color:var(--color-subtle-foreground)]">You: </span>
                              ) : null}
                              {conversation.lastMessagePreview}
                            </>
                          ) : (
                            <span className="italic text-[color:var(--color-subtle-foreground)]">No messages yet</span>
                          )}
                        </span>
                        {conversation.pendingCount > 0 ? (
                          <span
                            title={`${conversation.pendingCount} message(s) queued or unsent`}
                            className="tabular shrink-0 rounded-full bg-[var(--color-warning-bg)] px-1.5 py-px text-[10px] font-medium text-[color:var(--color-warning-fg)] ring-1 ring-inset ring-[var(--color-warning-border)]"
                          >
                            {conversation.pendingCount}
                          </span>
                        ) : null}
                      </span>

                      <span className="mt-1 flex flex-wrap items-center gap-1">
                        {!conversation.isMonitored ? (
                          <span className="rounded-[var(--radius-xs)] bg-[var(--color-neutral-bg)] px-1.5 py-px text-[10px] text-[color:var(--color-neutral-fg)]">
                            Not monitored
                          </span>
                        ) : null}
                        {conversation.aiAutomationEnabled ? (
                          <span className="rounded-[var(--radius-xs)] bg-[var(--color-info-bg)] px-1.5 py-px text-[10px] text-[color:var(--color-info-fg)]">
                            AI on
                          </span>
                        ) : null}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
