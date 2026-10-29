"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { usePathname } from "next/navigation";
import {
  AlertTriangle,
  ArrowUpRight,
  AtSign,
  Bookmark,
  CheckSquare,
  Flag,
  ListFilter,
  Rows3,
  Rows4,
  Search,
  Square,
  Star,
  UserRound,
  Users,
  X,
} from "lucide-react";
import Link from "@/components/ProjectLink";
import { Button, Dialog, useToast } from "@/components/ui";
import { listInboxAction } from "@/server/actions/channelInbox";
import {
  bulkUpdateConversations,
  deleteInboxView,
  listMyMentions,
  listSavedInboxViews,
  markMentionsRead,
  saveInboxView,
  setInboxViewPreference,
  type BulkOp,
  type InboxMentionItem,
  type SavedInboxView,
} from "@/server/actions/inbox";
import type { InboxCounts, InboxItem, InboxChannel } from "@/server/channels/inbox";
import {
  CONVERSATION_PRIORITIES,
  CONVERSATION_PRIORITY_LABEL,
  EMPTY_INBOX_FILTERS,
  inboxFilterKey,
  isDefaultInboxFilters,
  type ConversationPriorityValue,
  type InboxFilterSet,
  type InboxScope,
  type InboxViewKey,
} from "@support-automation/shared";
import { conversationAvatar } from "../chat/avatar";
import { ChannelMark, CHANNEL_PRESENTATION } from "./ChannelMark";

/**
 * The unified inbox's list pane (OMNICHANNEL.md §4, INBOX_WORKSPACE.md § Inbox): channel tabs, views,
 * filters, saved views, bulk selection and the merged conversation list, beside whichever conversation
 * is open.
 *
 * The default list comes from the layout (the server tree, refreshed every few seconds). Any filter,
 * view or search is answered by the server over EVERY conversation — never by filtering the 300
 * rows already on screen. Results are kept WITH the query they answered, so a slow response can never
 * land under a newer query.
 */

export interface InboxOptions {
  teams: { id: string; name: string }[];
  accounts: { key: string; label: string }[];
  people: { id: string; name: string }[];
  /** Notes / tags / priority (INBOX_COLLABORATION) are on for this project. */
  collaboration: boolean;
  /** May share views with the team (channels.manage). */
  canShare: boolean;
}

const SCOPES: Array<{ scope: InboxScope; channel: InboxChannel | null; label: string }> = [
  { scope: "all", channel: null, label: "All" },
  { scope: "whatsapp", channel: "WHATSAPP", label: "WhatsApp" },
  { scope: "messenger", channel: "MESSENGER", label: "Messenger" },
  { scope: "instagram", channel: "INSTAGRAM", label: "Instagram" },
  { scope: "telegram", channel: "TELEGRAM", label: "Telegram" },
];

const VIEWS: Array<{ view: InboxViewKey; label: string; count?: keyof Omit<InboxCounts, "byChannel">; collaboration?: boolean }> = [
  { view: "all", label: "Open", count: "all" },
  { view: "mine", label: "My inbox", count: "mine" },
  { view: "unassigned", label: "Unassigned" },
  { view: "unread", label: "Unread", count: "unread" },
  { view: "needs-reply", label: "Needs reply", count: "needsReply" },
  { view: "high", label: "High priority", collaboration: true },
  { view: "urgent", label: "Urgent", collaboration: true },
  { view: "closed", label: "Closed", count: "closed" },
];

const PRIORITY_STYLE: Record<ConversationPriorityValue, string> = {
  NONE: "",
  LOW: "text-[color:var(--color-info-fg)]",
  NORMAL: "text-[color:var(--color-success-fg)]",
  HIGH: "text-[color:var(--color-warning-fg)]",
  URGENT: "text-[color:var(--color-danger-fg)]",
};

// Density preference: one localStorage value, read without a server/client mismatch.
const DENSITY_KEY = "inbox-density";
const densityListeners = new Set<() => void>();
const readDensity = () => {
  try {
    return window.localStorage.getItem(DENSITY_KEY) === "compact" ? "compact" : "comfortable";
  } catch {
    return "comfortable";
  }
};
const writeDensity = (v: "compact" | "comfortable") => {
  try {
    window.localStorage.setItem(DENSITY_KEY, v);
  } catch {
    /* private mode */
  }
  densityListeners.forEach((l) => l());
};

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

export function InboxWorkspace({
  scope,
  items,
  counts,
  truncated,
  options,
  children,
}: {
  scope: InboxScope;
  items: InboxItem[];
  counts: InboxCounts;
  truncated: boolean;
  options: InboxOptions;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const { showToast } = useToast();
  const threadOpen = /\/conversations\/[^/]+\/c\//.test(pathname);
  const [filters, setFilters] = useState<InboxFilterSet>(EMPTY_INBOX_FILTERS);
  const [result, setResult] = useState<{ key: string; items: InboxItem[]; truncated: boolean } | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [pending, startTransition] = useTransition();
  const [showFilters, setShowFilters] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [views, setViews] = useState<SavedInboxView[] | null>(null);
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [mentions, setMentions] = useState<{ unread: number; items: InboxMentionItem[] } | null>(null);
  const [mentionsOpen, setMentionsOpen] = useState(false);
  const [viewDialog, setViewDialog] = useState<null | { asNew: boolean }>(null);
  const [tagDialog, setTagDialog] = useState(false);
  const density = useSyncExternalStore(
    (l) => {
      densityListeners.add(l);
      return () => densityListeners.delete(l);
    },
    readDensity,
    () => "comfortable" as const,
  );
  const searchRef = useRef<HTMLInputElement>(null);

  const key = inboxFilterKey(filters);
  const filtered = !isDefaultInboxFilters(filters);

  // Saved views and mentions once on arrival (and after each change); the default view applies once.
  const appliedDefault = useRef(false);
  useEffect(() => {
    let live = true;
    void listSavedInboxViews().then((v) => {
      if (!live) return;
      setViews(v);
      const def = v.find((x) => x.isDefault);
      if (def && !appliedDefault.current && def.scope === scope) {
        appliedDefault.current = true;
        setFilters(def.filters);
        setActiveViewId(def.id);
      }
    });
    if (options.collaboration) void listMyMentions().then((m) => live && setMentions(m));
    return () => {
      live = false;
    };
  }, [scope, options.collaboration, refreshTick]);

  // Ask the server whenever the query changes, and again whenever the layout's own refresh brings new
  // data (the `items` identity changes), so a filtered list stays as live as the default one.
  useEffect(() => {
    if (!filtered) return;
    const handle = setTimeout(
      () =>
        startTransition(async () => {
          const answer = await listInboxAction({ scope, filters });
          if (answer) setResult({ key, items: answer.items, truncated: answer.truncated });
        }),
      filters.search ? 300 : 0,
    );
    return () => clearTimeout(handle);
  }, [filtered, key, scope, filters, items, refreshTick]);

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
  const set = (patch: Partial<InboxFilterSet>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setActiveViewId(null);
  };
  const extraFilters = [filters.teamId, filters.assigneeId, filters.tag, filters.account].filter(Boolean).length;
  const visibleViews = VIEWS.filter((v) => !v.collaboration || options.collaboration);

  const runBulk = (op: BulkOp) => {
    const refs = (shown?.items ?? []).filter((i) => selected.has(i.key)).map((i) => i.ref);
    if (refs.length === 0) return;
    startTransition(async () => {
      const r = await bulkUpdateConversations(refs, op);
      if ("error" in r) {
        showToast({ tone: "danger", title: r.error });
        return;
      }
      const parts = [`${r.changed} changed`, r.unchanged ? `${r.unchanged} already so` : null, r.skipped ? `${r.skipped} skipped` : null, r.failed ? `${r.failed} failed` : null].filter(Boolean);
      showToast({ tone: r.failed ? "danger" : "success", title: parts.join(", "), description: r.notes.join(" ") || undefined });
      setRefreshTick((t) => t + 1);
    });
  };

  const applyView = (v: SavedInboxView) => {
    setFilters(v.filters);
    setActiveViewId(v.id);
  };

  const saveCurrent = (asNew: boolean, name: string, share: boolean) => {
    const current = views?.find((v) => v.id === activeViewId);
    startTransition(async () => {
      const r = await saveInboxView({ id: asNew ? null : (current?.id ?? null), name, shared: share, scope, filters });
      if ("error" in r) showToast({ tone: "danger", title: r.error });
      else {
        setViewDialog(null);
        setActiveViewId(r.id);
        setRefreshTick((t) => t + 1);
        showToast({ tone: "success", title: `Saved “${name}”.` });
      }
    });
  };
  const currentView = views?.find((v) => v.id === activeViewId) ?? null;

  return (
    <div className="flex min-h-0 flex-1">
      <aside
        className={`flex w-full min-w-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface-sunken)] md:w-[22rem] md:shrink-0 lg:w-[25rem] ${threadOpen ? "max-md:hidden" : ""}`}
        aria-label="Conversations"
      >
        <div className="shrink-0 space-y-2.5 border-b border-[var(--color-border)] px-3.5 pb-3 pt-3.5">
          <div className="flex items-center gap-2">
            <nav className="-mx-1 flex min-w-0 flex-1 gap-1 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none]" aria-label="Channels">
              {SCOPES.map((s) => {
                const active = s.scope === scope;
                const count = s.channel ? counts.byChannel[s.channel] : null;
                return (
                  <Link
                    key={s.scope}
                    href={`/conversations/${s.scope}`}
                    aria-current={active ? "page" : undefined}
                    className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors ${
                      active ? "bg-[var(--color-primary)] text-[var(--color-on-primary)]" : "text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)]"
                    }`}
                  >
                    {s.channel ? <ChannelMark channel={s.channel} size="xs" /> : null}
                    {s.label}
                    {scope === "all" && count ? <span className={`tabular text-[10.5px] ${active ? "opacity-80" : "opacity-70"}`}>{count}</span> : null}
                  </Link>
                );
              })}
            </nav>
            {options.collaboration ? (
              <div className="relative shrink-0">
                <button
                  type="button"
                  onClick={() => setMentionsOpen((o) => !o)}
                  aria-label={`Mentions${mentions?.unread ? `, ${mentions.unread} unread` : ""}`}
                  aria-expanded={mentionsOpen}
                  className="relative flex size-7 items-center justify-center rounded-[var(--radius-md)] text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)]"
                >
                  <AtSign className="size-4" aria-hidden />
                  {mentions?.unread ? (
                    <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-[var(--color-danger-fg)] px-1 text-center text-[9.5px] font-semibold leading-4 text-white">{mentions.unread > 9 ? "9+" : mentions.unread}</span>
                  ) : null}
                </button>
                {mentionsOpen ? (
                  <MentionsPopover
                    data={mentions}
                    onClose={() => setMentionsOpen(false)}
                    onRead={(ids) => {
                      void markMentionsRead(ids).then(() => setRefreshTick((t) => t + 1));
                    }}
                  />
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="flex gap-1.5">
            <label className="relative block min-w-0 flex-1">
              <span className="sr-only">Search conversations</span>
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[color:var(--color-subtle-foreground)]" aria-hidden />
              <input
                ref={searchRef}
                type="search"
                value={filters.search}
                onChange={(e) => set({ search: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Escape") set({ search: "" });
                }}
                placeholder="Search names and messages   /"
                className="h-8.5 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] pl-8 pr-8 text-[13px] text-[color:var(--color-foreground)] placeholder:text-[color:var(--color-subtle-foreground)] focus:border-[var(--color-focus-ring)] focus:outline-none focus:ring-2 focus:ring-[var(--color-focus-ring)]/30"
              />
              {filters.search ? (
                <button type="button" onClick={() => set({ search: "" })} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-[color:var(--color-subtle-foreground)] hover:text-[color:var(--color-foreground)]" aria-label="Clear search">
                  <X className="size-3.5" aria-hidden />
                </button>
              ) : null}
            </label>
            <IconToggle label="Filters" active={showFilters || extraFilters > 0} onClick={() => setShowFilters((s) => !s)} badge={extraFilters || null}>
              <ListFilter className="size-4" aria-hidden />
            </IconToggle>
            <IconToggle label={selecting ? "Done selecting" : "Select conversations"} active={selecting} onClick={() => (setSelecting((s) => !s), setSelected(new Set()))}>
              <CheckSquare className="size-4" aria-hidden />
            </IconToggle>
            <IconToggle label={density === "compact" ? "Comfortable rows" : "Compact rows"} active={false} onClick={() => writeDensity(density === "compact" ? "comfortable" : "compact")}>
              {density === "compact" ? <Rows3 className="size-4" aria-hidden /> : <Rows4 className="size-4" aria-hidden />}
            </IconToggle>
          </div>

          {views && views.length > 0 ? (
            <div className="-mx-1 flex gap-1 overflow-x-auto px-1 [scrollbar-width:none]" aria-label="Saved views">
              {[...views]
                .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name))
                .map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => applyView(v)}
                    aria-pressed={activeViewId === v.id}
                    title={v.shared ? "Shared with the team" : "Only you see this view"}
                    className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[11.5px] ring-1 transition-colors ${
                      activeViewId === v.id ? "bg-[var(--color-surface)] font-medium text-[color:var(--color-foreground)] ring-[var(--color-border-strong)]" : "text-[color:var(--color-muted-foreground)] ring-[var(--color-border)] hover:text-[color:var(--color-foreground)]"
                    }`}
                  >
                    {v.pinned ? <Star className="size-3 fill-current" aria-hidden /> : <Bookmark className="size-3" aria-hidden />}
                    {v.name}
                    {v.shared ? <Users className="size-3 opacity-60" aria-hidden /> : null}
                  </button>
                ))}
            </div>
          ) : null}

          <div className="flex items-center gap-2">
            <div className="-mx-1 flex min-w-0 flex-1 gap-1 overflow-x-auto px-1 [scrollbar-width:none]" role="tablist" aria-label="Views">
              {visibleViews.map((v) => {
                const active = v.view === filters.view;
                const n = v.count ? counts[v.count] : 0;
                return (
                  <button
                    key={v.view}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => set({ view: v.view })}
                    className={`inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-sm)] px-2 py-1 text-[11.5px] font-medium transition-colors ${
                      active ? "bg-[var(--color-surface)] text-[color:var(--color-foreground)] shadow-[var(--shadow-xs)] ring-1 ring-inset ring-[var(--color-border)]" : "text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
                    }`}
                  >
                    {v.view === "urgent" || v.view === "high" ? <Flag className={`size-3 ${v.view === "urgent" ? "text-[color:var(--color-danger-fg)]" : "text-[color:var(--color-warning-fg)]"}`} aria-hidden /> : null}
                    {v.label}
                    {n > 0 ? <span className={`tabular text-[10.5px] ${v.view === "unread" ? "text-[color:var(--color-warning-fg)]" : "opacity-70"}`}>{n}</span> : null}
                  </button>
                );
              })}
            </div>
          </div>

          {showFilters ? (
            <div className="grid grid-cols-2 gap-1.5 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-2">
              <FilterSelect label="Account" value={filters.account} onChange={(v) => set({ account: v })} options={options.accounts.map((a) => ({ value: a.key, label: a.label }))} />
              <FilterSelect label="Last activity" value={filters.within} onChange={(v) => set({ within: v as InboxFilterSet["within"] })} options={[{ value: "24h", label: "Last 24 h" }, { value: "7d", label: "Last 7 days" }, { value: "30d", label: "Last 30 days" }]} />
              <FilterSelect label="Assigned to" value={filters.assigneeId} onChange={(v) => set({ assigneeId: v })} options={options.people.map((p) => ({ value: p.id, label: p.name }))} />
              <FilterSelect label="Team" value={filters.teamId} onChange={(v) => set({ teamId: v })} options={options.teams.map((t) => ({ value: t.id, label: t.name }))} />
              {options.collaboration ? (
                <label className="col-span-2 flex items-center gap-1.5 text-[11.5px] text-[color:var(--color-muted-foreground)]">
                  Tag
                  <input
                    value={filters.tag ?? ""}
                    onChange={(e) => set({ tag: e.target.value.trim().toLowerCase().replace(/^#/, "") || null })}
                    placeholder="e.g. billing"
                    className="h-7 min-w-0 flex-1 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-[12px] text-[color:var(--color-foreground)]"
                  />
                </label>
              ) : null}
              <div className="col-span-2 flex flex-wrap items-center gap-1.5 pt-1">
                <button type="button" onClick={() => setViewDialog({ asNew: true })} disabled={!filtered || pending} className="rounded-[var(--radius-sm)] px-2 py-1 text-[11.5px] font-medium ring-1 ring-[var(--color-border)] hover:bg-[var(--color-neutral-bg)] disabled:opacity-50">
                  Save as view…
                </button>
                {currentView && (currentView.mine || (currentView.shared && options.canShare)) ? (
                  <>
                    <button type="button" onClick={() => setViewDialog({ asNew: false })} disabled={pending} className="rounded-[var(--radius-sm)] px-2 py-1 text-[11.5px] ring-1 ring-[var(--color-border)] hover:bg-[var(--color-neutral-bg)]">
                      Update view
                    </button>
                  </>
                ) : null}
                {activeViewId ? (
                  <ViewMenu
                    view={views?.find((v) => v.id === activeViewId) ?? null}
                    onChanged={() => setRefreshTick((t) => t + 1)}
                    onDeleted={() => {
                      setActiveViewId(null);
                      setRefreshTick((t) => t + 1);
                    }}
                  />
                ) : null}
                <span className="flex-1" />
                {filtered ? (
                  <button type="button" onClick={() => (setFilters(EMPTY_INBOX_FILTERS), setActiveViewId(null))} className="text-[11.5px] text-[color:var(--color-muted-foreground)] underline-offset-2 hover:underline">
                    Clear all
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}

          {selecting ? (
            <BulkBar
              count={selected.size}
              total={shown?.items.length ?? 0}
              onAll={() => setSelected(new Set((shown?.items ?? []).map((i) => i.key)))}
              onNone={() => setSelected(new Set())}
              onRun={runBulk}
              onAddTag={() => setTagDialog(true)}
              options={options}
              disabled={pending}
            />
          ) : null}
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
              {filters.search ? `Nothing matches “${filters.search}”.` : !filtered ? "No conversations yet. They appear here as soon as a customer writes." : "Nothing matches these filters right now."}
            </p>
          ) : (
            <ul>
              {shown.items.map((item) => (
                <InboxRow
                  key={item.key}
                  item={item}
                  compact={density === "compact"}
                  active={item.key === `ch:${activeKey}`}
                  selecting={selecting}
                  selected={selected.has(item.key)}
                  onToggle={() =>
                    setSelected((s) => {
                      const next = new Set(s);
                      if (next.has(item.key)) next.delete(item.key);
                      else next.add(item.key);
                      return next;
                    })
                  }
                />
              ))}
            </ul>
          )}
          {shown?.truncated ? <p className="px-4 py-3 text-center text-[11px] text-[color:var(--color-subtle-foreground)]">Showing the 300 most recent matches. Narrow the filters or search to reach the rest.</p> : null}
        </div>
      </aside>

      <section className={`flex min-w-0 flex-1 flex-col bg-[var(--color-surface)] ${threadOpen ? "" : "max-md:hidden"}`}>{children}</section>

      {viewDialog ? (
        <SaveViewDialog
          key={`${viewDialog.asNew}-${activeViewId}`}
          asNew={viewDialog.asNew}
          initial={viewDialog.asNew ? null : currentView}
          canShare={options.canShare}
          pending={pending}
          onClose={() => setViewDialog(null)}
          onSave={(name, share) => saveCurrent(viewDialog.asNew, name, share)}
        />
      ) : null}
      {tagDialog ? (
        <TagDialog
          count={selected.size}
          onClose={() => setTagDialog(false)}
          onSave={(tag) => {
            setTagDialog(false);
            runBulk({ op: "addTag", tag });
          }}
        />
      ) : null}
    </div>
  );
}

function SaveViewDialog({
  asNew,
  initial,
  canShare,
  pending,
  onClose,
  onSave,
}: {
  asNew: boolean;
  initial: SavedInboxView | null;
  canShare: boolean;
  pending: boolean;
  onClose: () => void;
  onSave: (name: string, share: boolean) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [share, setShare] = useState(initial?.shared ?? false);
  const submit = () => {
    if (name.trim()) onSave(name.trim(), share);
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={asNew ? "Save as a view" : "Update this view"}
      description="Saves the current channel, view and filters. A view only narrows what each person can already see."
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" loading={pending} disabled={!name.trim()} onClick={submit}>
            Save view
          </Button>
        </>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="block text-[12.5px] font-medium">
          Name
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            placeholder="e.g. Urgent billing"
            className="mt-1 h-9 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-[13px] font-normal"
          />
        </label>
        {canShare ? (
          <label className="flex items-start gap-2 text-[12.5px]">
            <input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} className="mt-0.5" />
            <span>
              Share with the team
              <span className="block text-[11.5px] text-[color:var(--color-muted-foreground)]">Everyone who can read the inbox sees it; only managers can change it.</span>
            </span>
          </label>
        ) : (
          <p className="text-[11.5px] text-[color:var(--color-muted-foreground)]">Only you will see this view.</p>
        )}
      </form>
    </Dialog>
  );
}

function TagDialog({ count, onClose, onSave }: { count: number; onClose: () => void; onSave: (tag: string) => void }) {
  const [tag, setTag] = useState("");
  const submit = () => {
    if (tag.trim()) onSave(tag.trim());
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Add a tag to ${count} conversation${count === 1 ? "" : "s"}`}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!tag.trim()} onClick={submit}>
            Add tag
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          autoFocus
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          maxLength={40}
          placeholder="e.g. billing"
          aria-label="Tag"
          className="h-9 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-[13px]"
        />
      </form>
    </Dialog>
  );
}


function IconToggle({ label, active, onClick, badge, children }: { label: string; active: boolean; onClick: () => void; badge?: number | null; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={`relative flex size-8.5 shrink-0 items-center justify-center rounded-[var(--radius-md)] border transition-colors ${
        active ? "border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[color:var(--color-foreground)]" : "border-[var(--color-border)] bg-[var(--color-surface)] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
      }`}
    >
      {children}
      {badge ? <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-[var(--color-primary)] px-1 text-center text-[9.5px] font-semibold leading-4 text-[var(--color-on-primary)]">{badge}</span> : null}
    </button>
  );
}

function FilterSelect({ label, value, onChange, options }: { label: string; value: string | null; onChange: (v: string | null) => void; options: { value: string; label: string }[] }) {
  return (
    <label className="flex min-w-0 flex-col gap-0.5 text-[11px] text-[color:var(--color-muted-foreground)]">
      {label}
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} className="h-7 min-w-0 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 text-[12px] text-[color:var(--color-foreground)]">
        <option value="">Any</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function ViewMenu({ view, onChanged, onDeleted }: { view: SavedInboxView | null; onChanged: () => void; onDeleted: () => void }) {
  const { showToast } = useToast();
  const [confirming, setConfirming] = useState(false);
  if (!view) return null;
  const act = (p: Promise<{ ok: true } | { error: string }>, after: () => void) =>
    void p.then((r) => {
      if ("error" in r) showToast({ tone: "danger", title: r.error });
      else after();
    });
  return (
    <>
      <button type="button" onClick={() => act(setInboxViewPreference({ viewId: view.id, pinned: !view.pinned }), onChanged)} className="rounded-[var(--radius-sm)] px-2 py-1 text-[11.5px] ring-1 ring-[var(--color-border)] hover:bg-[var(--color-neutral-bg)]">
        {view.pinned ? "Unpin" : "Pin"}
      </button>
      <button type="button" onClick={() => act(setInboxViewPreference({ viewId: view.id, isDefault: !view.isDefault }), onChanged)} className="rounded-[var(--radius-sm)] px-2 py-1 text-[11.5px] ring-1 ring-[var(--color-border)] hover:bg-[var(--color-neutral-bg)]">
        {view.isDefault ? "Not my default" : "Make default"}
      </button>
      {/* Two presses instead of a browser confirm: the second says exactly what it does. */}
      <button
        type="button"
        onClick={() => (confirming ? act(deleteInboxView(view.id), onDeleted) : setConfirming(true))}
        onBlur={() => setConfirming(false)}
        className="rounded-[var(--radius-sm)] px-2 py-1 text-[11.5px] text-[color:var(--color-danger-fg)] ring-1 ring-[var(--color-border)] hover:bg-[var(--color-danger-bg)]"
      >
        {confirming ? "Delete this view (conversations stay)" : "Delete"}
      </button>
    </>
  );
}

function BulkBar({
  count,
  total,
  onAll,
  onNone,
  onRun,
  onAddTag,
  options,
  disabled,
}: {
  count: number;
  total: number;
  onAll: () => void;
  onNone: () => void;
  onRun: (op: BulkOp) => void;
  onAddTag: () => void;
  options: InboxOptions;
  disabled: boolean;
}) {
  const none = count === 0 || disabled;
  const pick = (value: string, run: (v: string) => void) => {
    if (value) run(value);
  };
  return (
    <div className="space-y-1.5 rounded-[var(--radius-lg)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] p-2 text-[11.5px]">
      <div className="flex items-center gap-2">
        <span className="font-medium">{count} selected</span>
        <button type="button" onClick={onAll} className="underline-offset-2 hover:underline">
          Select all {total}
        </button>
        {count ? (
          <button type="button" onClick={onNone} className="underline-offset-2 hover:underline">
            Clear
          </button>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {options.collaboration ? (
          <select disabled={none} value="" onChange={(e) => pick(e.target.value, (v) => onRun({ op: "priority", value: v }))} className="h-7 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 disabled:opacity-50" aria-label="Set priority">
            <option value="">Priority…</option>
            {CONVERSATION_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {CONVERSATION_PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
        ) : null}
        {options.collaboration ? (
          <button
            type="button"
            disabled={none}
            onClick={onAddTag}
            className="rounded-[var(--radius-sm)] px-2 ring-1 ring-[var(--color-border)] hover:bg-[var(--color-neutral-bg)] disabled:opacity-50"
          >
            + Tag
          </button>
        ) : null}
        {options.collaboration ? (
          <select disabled={none} value="" onChange={(e) => pick(e.target.value, (v) => onRun({ op: "assignee", userId: v === "__none" ? null : v }))} className="h-7 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 disabled:opacity-50" aria-label="Assign to">
            <option value="">Assign…</option>
            <option value="__none">Nobody</option>
            {options.people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        ) : null}
        {options.collaboration && options.teams.length ? (
          <select disabled={none} value="" onChange={(e) => pick(e.target.value, (v) => onRun({ op: "team", teamId: v === "__none" ? null : v }))} className="h-7 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 disabled:opacity-50" aria-label="Team">
            <option value="">Team…</option>
            <option value="__none">No Team</option>
            {options.teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        ) : null}
        <button type="button" disabled={none} onClick={() => onRun({ op: "status", status: "CLOSED" })} className="rounded-[var(--radius-sm)] px-2 ring-1 ring-[var(--color-border)] hover:bg-[var(--color-neutral-bg)] disabled:opacity-50">
          Close
        </button>
        <button type="button" disabled={none} onClick={() => onRun({ op: "status", status: "OPEN" })} className="rounded-[var(--radius-sm)] px-2 ring-1 ring-[var(--color-border)] hover:bg-[var(--color-neutral-bg)] disabled:opacity-50">
          Reopen
        </button>
      </div>
    </div>
  );
}

function MentionsPopover({ data, onClose, onRead }: { data: { unread: number; items: InboxMentionItem[] } | null; onClose: () => void; onRead: (ids: string[] | "all") => void }) {
  return (
    <div role="dialog" aria-label="Mentions" className="absolute right-0 top-9 z-40 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-lg)]">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2 text-[12px]">
        <span className="font-semibold">Mentions</span>
        <span className="flex items-center gap-2">
          {data?.unread ? (
            <button type="button" onClick={() => onRead("all")} className="text-[11.5px] underline-offset-2 hover:underline">
              Mark all read
            </button>
          ) : null}
          <button type="button" onClick={onClose} aria-label="Close">
            <X className="size-3.5" aria-hidden />
          </button>
        </span>
      </div>
      <ul className="max-h-80 overflow-y-auto">
        {!data || data.items.length === 0 ? <li className="px-3 py-6 text-center text-[12px] text-[color:var(--color-muted-foreground)]">Nobody has mentioned you in a note yet.</li> : null}
        {data?.items.map((m) => (
          <li key={m.id} className={`border-b border-[var(--color-border)] last:border-0 ${m.read ? "" : "bg-[var(--color-warning-bg)]/40"}`}>
            <Link href={m.href} onClick={() => (!m.read ? onRead([m.id]) : undefined, onClose())} className="block px-3 py-2 hover:bg-[var(--color-neutral-bg)]">
              <span className="flex items-center justify-between gap-2 text-[11px] text-[color:var(--color-muted-foreground)]">
                <span className="truncate">
                  <span className="font-semibold text-[color:var(--color-foreground)]">{m.authorName}</span> in {m.conversationTitle}
                </span>
                <span suppressHydrationWarning>{relativeTime(m.createdAt)}</span>
              </span>
              <span className="mt-0.5 line-clamp-2 block text-[12.5px] text-[color:var(--color-foreground)]">{m.excerpt}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function InboxRow({ item, active, compact, selecting, selected, onToggle }: { item: InboxItem; active: boolean; compact: boolean; selecting: boolean; selected: boolean; onToggle: () => void }) {
  const avatar = conversationAvatar(item.key, item.title);
  const external = item.channel === "WHATSAPP";
  const rowClass = `group/row relative flex w-full gap-3 border-b border-[var(--color-border)] px-3.5 ${compact ? "py-2" : "py-3"} text-left transition-[background-color,transform] duration-[var(--duration-fast)] ease-[var(--ease-out)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-focus-ring)] ${
    active || selected ? "bg-[var(--color-surface)]" : "hover:bg-[var(--color-neutral-bg)]/60"
  }`;

  const body = (
    <>
      {selecting ? <span className="flex shrink-0 items-center">{selected ? <CheckSquare className="size-4 text-[color:var(--color-primary)]" aria-hidden /> : <Square className="size-4 text-[color:var(--color-subtle-foreground)]" aria-hidden />}</span> : null}
      <span className="relative shrink-0">
        <span aria-hidden style={{ background: avatar.background, color: avatar.color }} className={`flex ${compact ? "size-7 text-[10.5px]" : "size-9 text-[12px]"} items-center justify-center rounded-[var(--radius-lg)] font-semibold tracking-[-0.01em] shadow-[var(--highlight-top)]`}>
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
            {item.priority === "HIGH" || item.priority === "URGENT" ? <Flag className={`size-3 shrink-0 ${PRIORITY_STYLE[item.priority]}`} aria-label={`${CONVERSATION_PRIORITY_LABEL[item.priority]} priority`} /> : null}
            {item.isGroup ? <Users className="size-3 shrink-0 text-[color:var(--color-muted-foreground)]" aria-label="Group chat" /> : null}
            <span className={`truncate text-[13px] text-[color:var(--color-foreground)] ${item.unread ? "font-semibold" : "font-medium"}`}>{item.title}</span>
            {external && !selecting ? <ArrowUpRight className="size-3 shrink-0 text-[color:var(--color-subtle-foreground)] opacity-0 transition-opacity group-hover/row:opacity-100" aria-hidden /> : null}
          </span>
          <span className={`tabular shrink-0 text-[11px] ${item.unread ? "font-medium text-[color:var(--color-warning-fg)]" : "text-[color:var(--color-muted-foreground)]"}`} suppressHydrationWarning>
            {relativeTime(item.lastMessageAt)}
          </span>
        </span>
        <span className={`mt-0.5 block truncate text-[12px] ${item.unread ? "text-[color:var(--color-foreground)]" : "text-[color:var(--color-muted-foreground)]"}`}>
          {item.lastSendFailed ? (
            <span className="mr-1 inline-flex items-center gap-0.5 font-medium text-[color:var(--color-danger-fg)]">
              <AlertTriangle className="size-3" aria-hidden />
              Not sent ·
            </span>
          ) : null}
          {item.preview ? (
            <>
              {item.lastMessageOutgoing ? <span className="text-[color:var(--color-subtle-foreground)]">You: </span> : null}
              {item.preview}
            </>
          ) : (
            <span className="italic text-[color:var(--color-subtle-foreground)]">No messages yet</span>
          )}
        </span>
        {compact ? null : (
          <span className="mt-1 flex flex-wrap items-center gap-1">
            <span className="text-[10.5px] text-[color:var(--color-subtle-foreground)]">
              {CHANNEL_PRESENTATION[item.channel].short} · {item.via}
            </span>
            {item.status === "CLOSED" ? <Chip>Closed</Chip> : null}
            {item.assigneeName ? (
              <Chip>
                <UserRound className="size-2.5" aria-hidden />
                {item.assignedToMe ? "You" : item.assigneeName}
              </Chip>
            ) : null}
            {item.teamName ? (
              <Chip>
                <Users className="size-2.5" aria-hidden />
                {item.teamName}
              </Chip>
            ) : null}
            {item.tags.slice(0, 2).map((t) => (
              <span key={t} className="rounded-[var(--radius-xs)] bg-[var(--color-info-bg)] px-1.5 py-px text-[10px] text-[color:var(--color-info-fg)]">
                #{t}
              </span>
            ))}
            {item.tags.length > 2 ? <span className="text-[10px] text-[color:var(--color-subtle-foreground)]">+{item.tags.length - 2}</span> : null}
            {item.aiOn ? <span className="rounded-[var(--radius-xs)] bg-[var(--color-info-bg)] px-1.5 py-px text-[10px] font-medium text-[color:var(--color-info-fg)]">AI on</span> : null}
            {item.connectionProblem ? (
              <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-[color:var(--color-danger-fg)]" title={item.connectionProblem}>
                <AlertTriangle className="size-2.5" aria-hidden />
                Can&apos;t reply
              </span>
            ) : null}
          </span>
        )}
      </span>
    </>
  );

  return (
    <li className="relative">
      {active ? <span aria-hidden className="absolute inset-y-0 left-0 z-[1] w-[3px] bg-[var(--color-primary)]" /> : null}
      {selecting ? (
        // A button while selecting, never a link with an intercepted click: middle-click must not navigate away and lose the selection.
        <button type="button" onClick={onToggle} aria-pressed={selected} className={rowClass}>
          {body}
        </button>
      ) : (
        <Link href={item.href} aria-current={active ? "page" : undefined} title={external ? "Opens in WhatsApp Chat" : undefined} className={`${rowClass} active:translate-y-px`}>
          {body}
        </Link>
      )}
    </li>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return <span className="inline-flex items-center gap-0.5 rounded-[var(--radius-xs)] bg-[var(--color-neutral-bg)] px-1.5 py-px text-[10px] text-[color:var(--color-neutral-fg)]">{children}</span>;
}
