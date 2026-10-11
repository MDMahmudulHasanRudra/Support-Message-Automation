"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { usePathname } from "next/navigation";
import { AlertTriangle, ArrowUpRight, Search, UserRound, Users, X } from "lucide-react";
import Link from "@/components/ProjectLink";
import { listInboxAction } from "@/server/actions/channelInbox";
import type { InboxCounts, InboxItem, InboxView, InboxWithin, InboxChannel } from "@/server/channels/inbox";
import type { InboxScope } from "@support-automation/shared";
import { conversationAvatar } from "../chat/avatar";
import { ChannelMark, CHANNEL_PRESENTATION } from "./ChannelMark";

/**
 * The unified inbox's list pane (OMNICHANNEL.md §4): channel tabs, filters, search, and the merged
 * conversation list, beside whichever conversation is open.
 *
 * The default list comes from the layout (the server tree, refreshed every few seconds). Any filter,
 * window or search is answered by the server over EVERY conversation — never by filtering the 300
 * rows already on screen, which would quietly hide whatever sorted past them. Results are kept WITH
 * the query they answered, so a slow response can never land under a newer query.
 */

const SCOPES: Array<{ scope: InboxScope; channel: InboxChannel | null; label: string }> = [
  { scope: "all", channel: null, label: "All" },
  { scope: "whatsapp", channel: "WHATSAPP", label: "WhatsApp" },
  { scope: "messenger", channel: "MESSENGER", label: "Messenger" },
  { scope: "instagram", channel: "INSTAGRAM", label: "Instagram" },
  { scope: "telegram", channel: "TELEGRAM", label: "Telegram" },
];

const VIEWS: Array<{ view: InboxView; label: string; count: keyof Omit<InboxCounts, "byChannel"> }> = [
  { view: "all", label: "Open", count: "all" },
  { view: "unread", label: "Unread", count: "unread" },
  { view: "needs-reply", label: "Needs reply", count: "needsReply" },
  { view: "mine", label: "Assigned to me", count: "mine" },
  { view: "closed", label: "Closed", count: "closed" },
];

function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Dhaka", month: "short", day: "numeric" }).format(new Date(iso));
}

const queryKey = (view: InboxView, within: InboxWithin, search: string) => `${view}|${within ?? ""}|${search.trim()}`;

export function InboxWorkspace({
  scope,
  items,
  counts,
  truncated,
  children,
}: {
  scope: InboxScope;
  items: InboxItem[];
  counts: InboxCounts;
  truncated: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const threadOpen = /\/conversations\/[^/]+\/c\//.test(pathname);
  const [view, setView] = useState<InboxView>("all");
  const [within, setWithin] = useState<InboxWithin>(null);
  const [search, setSearch] = useState("");
  const [result, setResult] = useState<{ key: string; items: InboxItem[]; truncated: boolean } | null>(null);
  const [pending, startTransition] = useTransition();
  const searchRef = useRef<HTMLInputElement>(null);

  const key = queryKey(view, within, search);
  const filtered = key !== queryKey("all", null, "");

  // Ask the server whenever the query changes, and again whenever the layout's own refresh brings new
  // data (the `items` identity changes), so a filtered list stays as live as the default one.
  useEffect(() => {
    if (!filtered) return;
    const handle = setTimeout(
      () =>
        startTransition(async () => {
          const answer = await listInboxAction({ scope, view, search, within });
          if (answer) setResult({ key, items: answer.items, truncated: answer.truncated });
        }),
      search.trim() ? 300 : 0,
    );
    return () => clearTimeout(handle);
  }, [filtered, key, scope, view, search, within, items]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (e.key !== "/" || target?.closest("input, textarea, select, [contenteditable=true]")) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const shown = filtered ? (result?.key === key ? result : null) : { items, truncated };
  const activeKey = useMemo(() => pathname.match(/\/c\/([^/?#]+)/)?.[1] ?? null, [pathname]);

  return (
    <div className="flex min-h-0 flex-1">
      <aside
        className={`flex w-full min-w-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface-sunken)] md:w-[22rem] md:shrink-0 lg:w-[24rem] ${threadOpen ? "max-md:hidden" : ""}`}
        aria-label="Conversations"
      >
        <div className="shrink-0 space-y-2.5 border-b border-[var(--color-border)] px-3.5 pb-3 pt-3.5">
          <nav className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none]" aria-label="Channels">
            {SCOPES.map((s) => {
              const active = s.scope === scope;
              const count = s.channel ? counts.byChannel[s.channel] : null;
              return (
                <Link
                  key={s.scope}
                  href={`/conversations/${s.scope}`}
                  aria-current={active ? "page" : undefined}
                  className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors ${
                    active
                      ? "bg-[var(--color-primary)] text-[var(--color-on-primary)]"
                      : "text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)]"
                  }`}
                >
                  {s.channel ? <ChannelMark channel={s.channel} size="xs" /> : null}
                  {s.label}
                  {scope === "all" && count ? <span className={`tabular text-[10.5px] ${active ? "opacity-80" : "opacity-70"}`}>{count}</span> : null}
                </Link>
              );
            })}
          </nav>

          <label className="relative block">
            <span className="sr-only">Search conversations</span>
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[color:var(--color-subtle-foreground)]" aria-hidden />
            <input
              ref={searchRef}
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setSearch("");
              }}
              placeholder="Search names and messages   /"
              className="h-8.5 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] pl-8 pr-8 text-[13px] text-[color:var(--color-foreground)] placeholder:text-[color:var(--color-subtle-foreground)] focus:border-[var(--color-focus-ring)] focus:outline-none focus:ring-2 focus:ring-[var(--color-focus-ring)]/30"
            />
            {search ? (
              <button type="button" onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-[color:var(--color-subtle-foreground)] hover:text-[color:var(--color-foreground)]" aria-label="Clear search">
                <X className="size-3.5" aria-hidden />
              </button>
            ) : null}
          </label>

          <div className="flex items-center gap-2">
            <div className="-mx-1 flex min-w-0 flex-1 gap-1 overflow-x-auto px-1 [scrollbar-width:none]" role="tablist" aria-label="Filter">
              {VIEWS.map((v) => {
                const active = v.view === view;
                const n = counts[v.count];
                return (
                  <button
                    key={v.view}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setView(v.view)}
                    className={`inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-sm)] px-2 py-1 text-[11.5px] font-medium transition-colors ${
                      active
                        ? "bg-[var(--color-surface)] text-[color:var(--color-foreground)] shadow-[var(--shadow-xs)] ring-1 ring-inset ring-[var(--color-border)]"
                        : "text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
                    }`}
                  >
                    {v.label}
                    {n > 0 ? <span className={`tabular text-[10.5px] ${v.view === "unread" && n > 0 ? "text-[color:var(--color-warning-fg)]" : "opacity-70"}`}>{n}</span> : null}
                  </button>
                );
              })}
            </div>
            <select
              value={within ?? ""}
              onChange={(e) => setWithin((e.target.value || null) as InboxWithin)}
              aria-label="Last activity"
              className="h-7 shrink-0 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 text-[11.5px] text-[color:var(--color-foreground)]"
            >
              <option value="">Any time</option>
              <option value="24h">Last 24 h</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
            </select>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto" aria-busy={pending || !shown}>
          {!shown ? (
            <ul aria-hidden>
              {Array.from({ length: 6 }, (_, i) => (
                <li key={i} className="flex gap-3 border-b border-[var(--color-border)] px-3.5 py-3">
                  <span className="size-9 shrink-0 animate-pulse rounded-[var(--radius-lg)] bg-[var(--color-neutral-bg)]" />
                  <span className="flex-1 space-y-2 pt-1">
                    <span className="block h-3 w-2/3 animate-pulse rounded bg-[var(--color-neutral-bg)]" />
                    <span className="block h-2.5 w-5/6 animate-pulse rounded bg-[var(--color-neutral-bg)]" />
                  </span>
                </li>
              ))}
            </ul>
          ) : shown.items.length === 0 ? (
            <p className="px-6 py-12 text-center text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
              {search.trim() ? `Nothing matches “${search.trim()}”.` : view === "all" ? "No conversations yet. They appear here as soon as a customer writes." : "Nothing here right now."}
            </p>
          ) : (
            <ul>
              {shown.items.map((item) => (
                <InboxRow key={item.key} item={item} active={item.key === `ch:${activeKey}`} />
              ))}
            </ul>
          )}
          {shown?.truncated ? (
            <p className="px-4 py-3 text-center text-[11px] text-[color:var(--color-subtle-foreground)]">Showing the 300 most recent. Search to reach the rest.</p>
          ) : null}
        </div>
      </aside>

      <section className={`flex min-w-0 flex-1 flex-col bg-[var(--color-surface)] ${threadOpen ? "" : "max-md:hidden"}`}>{children}</section>
    </div>
  );
}

function InboxRow({ item, active }: { item: InboxItem; active: boolean }) {
  const avatar = conversationAvatar(item.key, item.title);
  const external = item.channel === "WHATSAPP";
  return (
    <li className="relative">
      {active ? <span aria-hidden className="absolute inset-y-0 left-0 z-[1] w-[3px] bg-[var(--color-primary)]" /> : null}
      <Link
        href={item.href}
        aria-current={active ? "page" : undefined}
        title={external ? "Opens in WhatsApp Chat" : undefined}
        className={`group/row relative flex w-full gap-3 border-b border-[var(--color-border)] px-3.5 py-3 text-left transition-[background-color,transform] duration-[var(--duration-fast)] ease-[var(--ease-out)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-focus-ring)] active:translate-y-px ${
          active ? "bg-[var(--color-surface)]" : "hover:bg-[var(--color-neutral-bg)]/60"
        }`}
      >
        <span className="relative shrink-0">
          <span
            aria-hidden
            style={{ background: avatar.background, color: avatar.color }}
            className="flex size-9 items-center justify-center rounded-[var(--radius-lg)] text-[12px] font-semibold tracking-[-0.01em] shadow-[var(--highlight-top)]"
          >
            {avatar.initials}
          </span>
          <span className="absolute -bottom-1 -right-1 rounded-[5px] bg-[var(--color-surface-sunken)] p-px">
            <ChannelMark channel={item.channel} size="xs" />
          </span>
          {item.unread ? (
            <>
              <span aria-hidden className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-[var(--color-warning)] shadow-[0_0_0_2px_var(--color-surface-sunken)]" />
              <span className="sr-only">Unread — a customer is waiting.</span>
            </>
          ) : item.needsReply ? (
            <>
              <span aria-hidden className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-[1.5px] border-[var(--color-warning)] bg-[var(--color-surface)] shadow-[0_0_0_2px_var(--color-surface-sunken)]" />
              <span className="sr-only">Seen, still needs a reply.</span>
            </>
          ) : null}
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5">
              {item.isGroup ? <Users className="size-3 shrink-0 text-[color:var(--color-muted-foreground)]" aria-label="Group chat" /> : null}
              <span className={`truncate text-[13px] text-[color:var(--color-foreground)] ${item.unread ? "font-semibold" : "font-medium"}`}>{item.title}</span>
              {external ? <ArrowUpRight className="size-3 shrink-0 text-[color:var(--color-subtle-foreground)] opacity-0 transition-opacity group-hover/row:opacity-100" aria-hidden /> : null}
            </span>
            <span className={`tabular shrink-0 text-[11px] ${item.unread ? "font-medium text-[color:var(--color-warning-fg)]" : "text-[color:var(--color-muted-foreground)]"}`} suppressHydrationWarning>
              {relativeTime(item.lastMessageAt)}
            </span>
          </span>
          <span className={`mt-0.5 block truncate text-[12px] ${item.unread ? "text-[color:var(--color-foreground)]" : "text-[color:var(--color-muted-foreground)]"}`}>
            {item.preview ? (
              <>
                {item.lastMessageOutgoing ? <span className="text-[color:var(--color-subtle-foreground)]">You: </span> : null}
                {item.preview}
              </>
            ) : (
              <span className="italic text-[color:var(--color-subtle-foreground)]">No messages yet</span>
            )}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-1">
            <span className="text-[10.5px] text-[color:var(--color-subtle-foreground)]">
              {CHANNEL_PRESENTATION[item.channel].short} · {item.via}
            </span>
            {item.status === "CLOSED" ? <span className="rounded-[var(--radius-xs)] bg-[var(--color-neutral-bg)] px-1.5 py-px text-[10px] text-[color:var(--color-neutral-fg)]">Closed</span> : null}
            {item.assigneeName ? (
              <span className="inline-flex items-center gap-0.5 rounded-[var(--radius-xs)] bg-[var(--color-neutral-bg)] px-1.5 py-px text-[10px] text-[color:var(--color-neutral-fg)]">
                <UserRound className="size-2.5" aria-hidden />
                {item.assignedToMe ? "You" : item.assigneeName}
              </span>
            ) : null}
            {item.aiOn ? <span className="rounded-[var(--radius-xs)] bg-[var(--color-info-bg)] px-1.5 py-px text-[10px] font-medium text-[color:var(--color-info-fg)]">AI on</span> : null}
            {item.connectionProblem ? (
              <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-[color:var(--color-danger-fg)]" title={item.connectionProblem}>
                <AlertTriangle className="size-2.5" aria-hidden />
                Can&apos;t reply
              </span>
            ) : null}
          </span>
        </span>
      </Link>
    </li>
  );
}
