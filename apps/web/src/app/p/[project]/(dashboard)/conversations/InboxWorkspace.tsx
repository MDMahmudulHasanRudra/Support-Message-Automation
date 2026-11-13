"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { usePathname } from "next/navigation";
import {
  AlertTriangle,
  AtSign,
  Bookmark,
  Bot,
  CheckCircle2,
  CheckSquare,
  Clock,
  Flag,
  Inbox,
  Layers,
  ListFilter,
  MoreHorizontal,
  Rows3,
  Rows4,
  Search,
  Square,
  Star,
  UserRound,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import Link, { useInWorkspace, useProjectRouter, useProjectSlug } from "@/components/ProjectLink";
import { projectHref } from "@/lib/projectPaths";
import { Button, Dialog, useToast } from "@/components/ui";
import { listInboxAction, moreMessageMatchesAction } from "@/server/actions/channelInbox";
import { bulkUpdateAcrossProjects, listUniversalInboxAction } from "@/server/actions/universalInbox";
import type { UniversalProjectView } from "@/server/universalInbox";
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
import type { InboxCounts, InboxItem, InboxChannel, MessageSearchInfo } from "@/server/channels/inbox";
import {
  CONVERSATION_PRIORITIES,
  CONVERSATION_PRIORITY_LABEL,
  CONVERSATION_STATUS_LABELS,
  CONVERSATION_STATUSES,
  EMPTY_INBOX_FILTERS,
  inboxFilterKey,
  isDefaultInboxFilters,
  ALL_PROJECTS_SCOPE,
  type ConversationPriorityValue,
  type InboxFilterSet,
  type InboxScope,
  type InboxViewKey,
  LEGACY_WHATSAPP_LABEL,
} from "@support-automation/shared";
import { conversationAvatar } from "../chat/avatar";
import { ChannelMark, CHANNEL_PRESENTATION } from "./ChannelMark";
import { projectColor, UniversalBoard } from "./UniversalBoard";

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
  /** Inbox V3 status, snooze and WhatsApp assignment (UNIFIED_INBOX_V3) are on for this project. */
  lifecycle: boolean;
  /** Mood Detection is switched on: offers the "upset customer" filter. */
  moodDetection: boolean;
  /** Automatic routing (AUTO_ROUTING with UNIFIED_INBOX_V3) is on: offers "Distribute evenly". */
  autoRouting: boolean;
  /** May share views with the team (channels.manage). */
  canShare: boolean;
}

const SCOPES: Array<{ scope: InboxScope; channel: InboxChannel | null; label: string }> = [
  { scope: "all", channel: null, label: "All" },
  { scope: "whatsapp", channel: "WHATSAPP", label: LEGACY_WHATSAPP_LABEL },
  { scope: "messenger", channel: "MESSENGER", label: "Messenger" },
  { scope: "instagram", channel: "INSTAGRAM", label: "Instagram" },
  { scope: "telegram", channel: "TELEGRAM", label: "Telegram" },
  { scope: "website", channel: "WEBCHAT", label: "Website" },
];

/** The four views people live in, always on screen. Everything else is under More. */
const MAIN_VIEWS: Array<{ view: InboxViewKey; label: string; icon: LucideIcon; count?: keyof Omit<InboxCounts, "byChannel"> }> = [
  { view: "mine", label: "Mine", icon: UserRound, count: "mine" },
  { view: "all", label: "Open", icon: Inbox, count: "all" },
  { view: "needs-reply", label: "Waiting", icon: Clock, count: "needsReply" },
  { view: "closed", label: "Closed", icon: CheckCircle2 },
];
const MORE_VIEWS: Array<{ view: InboxViewKey; label: string; count?: keyof Omit<InboxCounts, "byChannel">; collaboration?: boolean; lifecycle?: boolean }> = [
  { view: "unassigned", label: "Unassigned" },
  { view: "unread", label: "Unread", count: "unread" },
  { view: "high", label: "High priority", collaboration: true },
  { view: "urgent", label: "Urgent", collaboration: true },
  { view: "ai", label: "AI is handling", lifecycle: true },
];

/** A WhatsApp conversation opens beside the list too: the same view as WhatsApp Chat, at the inbox's own address. */
function inboxHref(href: string, scope: InboxScope): string {
  return href.startsWith("/chat/account/") ? `/conversations/${scope}/w/${href.slice("/chat/account/".length)}` : href;
}
function samePath(pathname: string, href: string): boolean {
  const path = href.split("?")[0]!;
  try {
    return decodeURIComponent(pathname).endsWith(decodeURIComponent(path));
  } catch {
    return pathname.endsWith(path);
  }
}

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

/** How long a customer has been waiting, in hours and minutes ("0h 5m", "26h 40m") — the report format. */
function waitedFor(iso: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60_000));
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

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

/**
 * What the All projects inbox remembers while a person moves between conversations. Opening a conversation in another
 * project is a new address, so the page is rebuilt; this keeps their place. Per browser tab, and only ever narrows a list.
 */
const universalMemory: { filters: InboxFilterSet; channel: InboxScope; project: string | null; scrollTop: number } = {
  filters: EMPTY_INBOX_FILTERS,
  channel: "all",
  project: null,
  scrollTop: 0,
};

type InboxRowData = InboxItem & { projectSlug?: string };

export function InboxWorkspace({
  scope,
  items,
  counts,
  truncated,
  options,
  universal = null,
  canSeeAllProjects = false,
  children,
}: {
  scope: InboxScope;
  items: InboxRowData[];
  counts: InboxCounts;
  truncated: boolean;
  options: InboxOptions;
  /** The All projects inbox (ALL_PROJECTS_INBOX.md); null in one project's own inbox. */
  universal?: { projects: UniversalProjectView[]; unavailable: string[] } | null;
  canSeeAllProjects?: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useProjectRouter();
  const workspace = useInWorkspace();
  const currentSlug = useProjectSlug();
  const { showToast } = useToast();
  const threadOpen = /\/conversations\/[^/]+\/(c|w)\//.test(pathname);
  const [filters, setFilters] = useState<InboxFilterSet>(universal ? universalMemory.filters : EMPTY_INBOX_FILTERS);
  const [channel, setChannel] = useState<InboxScope>(universal ? universalMemory.channel : scope);
  const [projectFilter, setProjectFilter] = useState<string | null>(universal ? universalMemory.project : null);
  const listRef = useRef<HTMLDivElement>(null);
  const listScope: InboxScope = universal ? channel : scope;
  const [result, setResult] = useState<{ key: string; items: InboxRowData[]; truncated: boolean; messageSearch: MessageSearchInfo | null } | null>(null);
  // Inbox V3 "More message matches": further pages of text matches for the query in `key`.
  const [more, setMore] = useState<{ key: string; items: InboxItem[]; nextCursor: string | null; loading: boolean; limitReached?: boolean } | null>(null);
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

  // With the scope: moving between channels keeps the filters, and an answer for the last channel is never shown under this one.
  const key = `${universal ? "every|" : ""}${listScope}|${inboxFilterKey(filters)}`;
  const filtered = !isDefaultInboxFilters(filters) || (Boolean(universal) && channel !== "all");
  const isUniversal = Boolean(universal);

  useEffect(() => {
    if (!isUniversal) return;
    universalMemory.filters = filters;
    universalMemory.channel = channel;
    universalMemory.project = projectFilter;
  }, [isUniversal, filters, channel, projectFilter]);

  // Back where they were in the list after opening a conversation in another project.
  useLayoutEffect(() => {
    if (isUniversal && listRef.current) listRef.current.scrollTop = universalMemory.scrollTop;
  }, [isUniversal]);

  // Saved views and mentions once on arrival (and after each change); the default view applies once.
  const appliedDefault = useRef(false);
  useEffect(() => {
    // Saved views and mentions belong to one project, and this list is not in one.
    if (isUniversal) return;
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
  }, [isUniversal, scope, options.collaboration, refreshTick]);

  // Ask the server whenever the query changes, and again whenever the layout's own refresh brings new
  // data (the `items` identity changes), so a filtered list stays as live as the default one.
  useEffect(() => {
    if (!filtered) return;
    const handle = setTimeout(
      () =>
        startTransition(async () => {
          if (isUniversal) {
            const answer = await listUniversalInboxAction({ channel: listScope, filters });
            if (answer) setResult({ key, items: answer.items, truncated: answer.truncated, messageSearch: null });
            return;
          }
          const answer = await listInboxAction({ scope, filters });
          if (answer) setResult({ key, items: answer.items, truncated: answer.truncated, messageSearch: answer.messageSearch });
        }),
      filters.search ? 300 : 0,
    );
    return () => clearTimeout(handle);
  }, [filtered, key, isUniversal, listScope, scope, filters, items, refreshTick]);

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

  const answered = filtered ? (result?.key === key ? result : null) : { items, truncated, messageSearch: null };
  const extra = more?.key === key ? more : null;
  const shown = answered && extra?.items.length ? { ...answered, items: [...answered.items, ...extra.items.filter((i) => !answered.items.some((a) => a.key === i.key))] } : answered;
  const messageSearch = answered?.messageSearch ?? null;
  const nextCursor = extra ? extra.nextCursor : (messageSearch?.nextCursor ?? null);
  const loadMoreMatches = async () => {
    if (!nextCursor || extra?.loading) return;
    const forKey = key;
    setMore((m) => ({ key: forKey, items: m?.key === forKey ? m.items : [], nextCursor, loading: true }));
    const held = [...(answered?.items ?? []), ...(extra?.items ?? [])];
    const seen = held.flatMap((i) => (i.ref.kind === "whatsapp" ? [`${i.ref.accountId}|${i.ref.chatId}`] : []));
    const page = await moreMessageMatchesAction({ scope, filters, cursor: nextCursor, seen });
    setMore((m) => {
      if (`${scope}|${inboxFilterKey(filters)}` !== forKey) return m;
      const kept = m?.key === forKey ? m.items : [];
      return { key: forKey, items: [...kept, ...page.items.filter((i) => !kept.some((k) => k.key === i.key))], nextCursor: page.messageSearch?.nextCursor ?? null, loading: false, limitReached: page.messageSearch?.limitReached ?? false };
    });
    if (page.messageSearch?.timedOut) showToast({ tone: "danger", title: "Message search took too long. Add another word to narrow it." });
  };
  const set = (patch: Partial<InboxFilterSet>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setActiveViewId(null);
  };
  const extraFilters = [filters.teamId, filters.assigneeId, filters.tag, filters.account].filter(Boolean).length;
  const moreViews = MORE_VIEWS.filter((v) => (!v.collaboration || options.collaboration) && (!v.lifecycle || options.lifecycle));

  const projectOf = (slug: string | undefined) => universal?.projects.find((p) => p.slug === slug) ?? null;
  const chosenProject = projectOf(projectFilter ?? undefined);
  const viewCounts = chosenProject ? chosenProject.counts : counts;
  const rows: InboxRowData[] = (shown?.items ?? []).filter((i: InboxRowData) => !projectFilter || i.projectSlug === projectFilter);
  const selectedRows = rows.filter((i) => selected.has(i.key));
  const selectedProjects = [...new Set(selectedRows.map((i) => i.projectSlug))];
  // Assigning needs a person and a Team of one project, so across projects those two are not offered.
  const bulkOptions: InboxOptions = !universal ? options : selectedProjects.length === 1 ? (projectOf(selectedProjects[0])?.options ?? options) : { ...options, people: [], teams: [], autoRouting: false };
  const openProject = universal && threadOpen ? projectOf(currentSlug ?? undefined) : null;

  const runBulk = (op: BulkOp) => {
    const refs = selectedRows.map((i) => i.ref);
    if (refs.length === 0) return;
    startTransition(async () => {
      const r = universal
        ? await bulkUpdateAcrossProjects(selectedProjects.map((slug) => ({ projectSlug: slug!, refs: selectedRows.filter((i) => i.projectSlug === slug).map((i) => i.ref) })), op)
        : await bulkUpdateConversations(refs, op);
      if ("error" in r) {
        showToast({ tone: "danger", title: r.error });
        return;
      }
      const parts = [`${r.changed} changed`, r.unchanged ? `${r.unchanged} already so` : null, r.skipped ? `${r.skipped} skipped` : null, r.failed ? `${r.failed} failed` : null].filter(Boolean);
      showToast({ tone: r.failed ? "danger" : "success", title: parts.join(", "), description: r.notes.join(" ") || undefined });
      setRefreshTick((t) => t + 1);
      if (universal) router.refresh();
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
        className={`flex w-full min-w-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)] md:w-[20rem] md:shrink-0 lg:w-[21.5rem] ${threadOpen ? "max-md:hidden" : ""}`}
        aria-label="Conversations"
      >
        {!workspace && (universal || canSeeAllProjects) ? (
          <div className="flex shrink-0 items-center gap-1 border-b border-[var(--color-border)] px-2 py-1.5" aria-label="Which projects">
            <Link href="/conversations/all" aria-current={universal ? undefined : "page"} className={`flex-1 rounded-[var(--radius-md)] px-2 py-1 text-center text-[12px] font-medium ${universal ? "text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-neutral-bg)]" : "bg-[var(--color-neutral-bg)] text-[color:var(--color-foreground)]"}`}>
              This project
            </Link>
            <Link href={`/conversations/${ALL_PROJECTS_SCOPE}`} aria-current={universal ? "page" : undefined} className={`flex flex-1 items-center justify-center gap-1.5 rounded-[var(--radius-md)] px-2 py-1 text-[12px] font-medium ${universal ? "bg-[var(--color-neutral-bg)] text-[color:var(--color-foreground)]" : "text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-neutral-bg)]"}`}>
              <Layers className="size-3.5" aria-hidden />
              All projects
            </Link>
          </div>
        ) : null}
        <div className="relative shrink-0 border-b border-[var(--color-border)]">
          <div role="tablist" aria-label="Views" className="flex items-stretch px-1.5 pt-1.5">
            {MAIN_VIEWS.map((v) => {
              const active = v.view === filters.view;
              const n = v.count ? viewCounts[v.count] : 0;
              return (
                <button
                  key={v.view}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => set({ view: v.view })}
                  className={`relative flex min-w-0 flex-1 flex-col items-center gap-0.5 border-b-2 px-0.5 pb-1.5 pt-1 text-[11.5px] font-medium transition-colors ${
                    active ? "border-[var(--color-accent)] text-[color:var(--color-foreground)]" : "border-transparent text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
                  }`}
                >
                  <v.icon className="size-4" aria-hidden />
                  <span className="flex items-baseline gap-1 whitespace-nowrap">
                    {v.label}
                    {n > 0 ? <span className={`tabular text-[10.5px] font-normal ${v.view === "needs-reply" ? "text-[color:var(--color-warning-fg)]" : "text-[color:var(--color-subtle-foreground)]"}`}>{n > 999 ? "999+" : n}</span> : null}
                  </span>
                </button>
              );
            })}
            <MoreViewsMenu views={moreViews} current={filters.view} counts={viewCounts} onPick={(view) => set({ view })} />
          </div>
        </div>

        <div className="relative shrink-0 space-y-2 border-b border-[var(--color-border)] px-3 py-2.5">
          <div className="flex items-center gap-1">
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
                placeholder="Search…"
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
          </div>

          <div className="flex items-center gap-1">
            <nav className="flex min-w-0 flex-1 items-center gap-0.5" aria-label="Channels">
              {SCOPES.map((s) => {
                const active = s.scope === listScope;
                const count = s.channel ? viewCounts.byChannel[s.channel] : null;
                const title = s.channel ? `${CHANNEL_PRESENTATION[s.channel].label}${count ? ` (${count})` : ""}` : "All channels";
                const tint = s.channel ? CHANNEL_PRESENTATION[s.channel].tint : null;
                const Icon = s.channel ? CHANNEL_PRESENTATION[s.channel].icon : null;
                if (universal) {
                  return (
                    <button
                      key={s.scope}
                      type="button"
                      onClick={() => setChannel(s.scope)}
                      aria-pressed={active}
                      aria-label={title}
                      title={title}
                      style={tint && active ? { background: `color-mix(in srgb, ${tint} 16%, transparent)`, color: tint } : undefined}
                      className={`flex h-7 shrink-0 items-center justify-center rounded-full text-[11.5px] font-medium transition-colors ${s.channel ? (active ? "gap-1.5 px-2.5" : "w-8") : "px-2.5"} ${
                        active ? (s.channel ? "" : "bg-[var(--color-primary)] text-[var(--color-on-primary)]") : "text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)]"
                      }`}
                    >
                      {Icon ? <Icon className="size-3.5 shrink-0" strokeWidth={2.2} aria-hidden /> : "All"}
                    {s.channel && active ? <span className="whitespace-nowrap">{CHANNEL_PRESENTATION[s.channel].short}</span> : null}
                    </button>
                  );
                }
                return (
                  <Link
                    key={s.scope}
                    href={`/conversations/${s.scope}`}
                    aria-current={active ? "page" : undefined}
                    aria-label={title}
                    title={title}
                    style={tint && active ? { background: `color-mix(in srgb, ${tint} 16%, transparent)`, color: tint } : undefined}
                    className={`flex h-7 shrink-0 items-center justify-center rounded-full text-[11.5px] font-medium transition-colors ${s.channel ? (active ? "gap-1.5 px-2.5" : "w-8") : "px-2.5"} ${
                      active ? (s.channel ? "" : "bg-[var(--color-primary)] text-[var(--color-on-primary)]") : "text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)]"
                    }`}
                  >
                    {Icon ? <Icon className="size-3.5 shrink-0" strokeWidth={2.2} aria-hidden /> : "All"}
                    {s.channel && active ? <span className="whitespace-nowrap">{CHANNEL_PRESENTATION[s.channel].short}</span> : null}
                  </Link>
                );
              })}
            </nav>
            {options.collaboration && !universal ? (
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
            <IconToggle label={density === "compact" ? "Comfortable rows" : "Compact rows"} active={false} onClick={() => writeDensity(density === "compact" ? "comfortable" : "compact")}>
              {density === "compact" ? <Rows3 className="size-4" aria-hidden /> : <Rows4 className="size-4" aria-hidden />}
            </IconToggle>
          </div>

          {universal ? (
            <div className="-mx-1 flex gap-1 overflow-x-auto px-1 [scrollbar-width:none]!" role="group" aria-label="Projects">
              <button type="button" onClick={() => setProjectFilter(null)} aria-pressed={!projectFilter} className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-[11.5px] font-medium ring-1 transition-colors ${!projectFilter ? "bg-[var(--color-neutral-bg)] text-[color:var(--color-foreground)] ring-[var(--color-border-strong)]" : "text-[color:var(--color-muted-foreground)] ring-[var(--color-border)] hover:text-[color:var(--color-foreground)]"}`}>
                All projects
              </button>
              {universal.projects.map((p) => (
                <button
                  key={p.slug}
                  type="button"
                  onClick={() => setProjectFilter(projectFilter === p.slug ? null : p.slug)}
                  aria-pressed={projectFilter === p.slug}
                  title={`${p.counts.needsReply} waiting in ${p.name}`}
                  className={`inline-flex max-w-[11rem] shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-medium ring-1 transition-colors ${projectFilter === p.slug ? "bg-[var(--color-neutral-bg)] text-[color:var(--color-foreground)] ring-[var(--color-border-strong)]" : "text-[color:var(--color-muted-foreground)] ring-[var(--color-border)] hover:text-[color:var(--color-foreground)]"}`}
                >
                  <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: projectColor(p.colorIndex) }} />
                  <span className="truncate">{p.name}</span>
                  {p.counts.needsReply > 0 ? <span className="tabular font-normal text-[color:var(--color-warning-fg)]">{p.counts.needsReply > 999 ? "999+" : p.counts.needsReply}</span> : null}
                </button>
              ))}
            </div>
          ) : null}

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

          {showFilters ? (
            <div className="absolute inset-x-2 top-full z-20 mt-1 grid grid-cols-2 gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-[var(--shadow-lg)]">
              <FilterSelect label="Account" value={filters.account} onChange={(v) => set({ account: v })} options={options.accounts.map((a) => ({ value: a.key, label: a.label }))} />
              <FilterSelect label="Last activity" value={filters.within} onChange={(v) => set({ within: v as InboxFilterSet["within"] })} options={[{ value: "24h", label: "Last 24 h" }, { value: "7d", label: "Last 7 days" }, { value: "30d", label: "Last 30 days" }]} />
              <FilterSelect label="Assigned to" value={filters.assigneeId} onChange={(v) => set({ assigneeId: v })} options={options.people.map((p) => ({ value: p.id, label: p.name }))} />
              <FilterSelect label="Team" value={filters.teamId} onChange={(v) => set({ teamId: v })} options={options.teams.map((t) => ({ value: t.id, label: t.name }))} />
              {options.lifecycle ? (
                <>
                  <FilterSelect
                    label="Sort"
                    anyLabel="Newest first"
                    value={filters.sort}
                    onChange={(v) => set({ sort: (v as InboxFilterSet["sort"]) ?? null })}
                    options={[
                      { value: "waiting", label: "Longest waiting" },
                      { value: "oldest", label: "Oldest first" },
                    ]}
                  />
                  <FilterSelect
                    label="Last message from"
                    value={filters.lastSender}
                    onChange={(v) => set({ lastSender: (v as InboxFilterSet["lastSender"]) ?? null })}
                    options={[
                      { value: "customer", label: "The customer" },
                      { value: "team", label: "Us" },
                    ]}
                  />
                </>
              ) : null}
              {options.moodDetection ? (
                <FilterSelect
                  label="Mood"
                  value={filters.mood}
                  onChange={(v) => set({ mood: (v as InboxFilterSet["mood"]) ?? null })}
                  options={[{ value: "upset", label: "Upset customer (last day, WhatsApp groups)" }]}
                />
              ) : null}
              {options.lifecycle ? (
                <FilterSelect
                  label="Status"
                  value={filters.status}
                  onChange={(v) => set({ status: (v as InboxFilterSet["status"]) ?? null })}
                  options={CONVERSATION_STATUSES.map((st) => ({ value: st, label: CONVERSATION_STATUS_LABELS[st] }))}
                />
              ) : null}
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
                {universal ? null : (
                <button type="button" onClick={() => setViewDialog({ asNew: true })} disabled={!filtered || pending} className="rounded-[var(--radius-sm)] px-2 py-1 text-[11.5px] font-medium ring-1 ring-[var(--color-border)] hover:bg-[var(--color-neutral-bg)] disabled:opacity-50">
                  Save as view…
                </button>
                )}
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
                  <button type="button" onClick={() => (setFilters(EMPTY_INBOX_FILTERS), setChannel("all"), setActiveViewId(null))} className="text-[11.5px] text-[color:var(--color-muted-foreground)] underline-offset-2 hover:underline">
                    Clear all
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}

          {selecting ? (
            <BulkBar
              count={selected.size}
              total={rows.length}
              onAll={() => setSelected(new Set(rows.map((i) => i.key)))}
              onNone={() => setSelected(new Set())}
              onRun={runBulk}
              onAddTag={() => setTagDialog(true)}
              options={bulkOptions}
              disabled={pending}
            />
          ) : null}
        </div>

        <div
          ref={listRef}
          onScroll={universal ? (e) => (universalMemory.scrollTop = e.currentTarget.scrollTop) : undefined}
          className="scroll-quiet min-h-0 flex-1 overflow-y-auto"
          aria-busy={pending || !shown}
        >
          {!shown ? (
            <ul aria-hidden>
              {Array.from({ length: 6 }, (_, i) => (
                <li key={i} className="flex gap-3 px-3 py-2.5">
                  <span className="size-10 shrink-0 animate-pulse rounded-full bg-[var(--color-neutral-bg)]" />
                  <span className="flex-1 space-y-2 pt-1">
                    <span className="block h-3 w-2/3 animate-pulse rounded bg-[var(--color-neutral-bg)]" />
                    <span className="block h-2.5 w-5/6 animate-pulse rounded bg-[var(--color-neutral-bg)]" />
                  </span>
                </li>
              ))}
            </ul>
          ) : rows.length === 0 ? (
            <p className="px-6 py-12 text-center text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
              {filters.search ? `Nothing matches “${filters.search}”.` : !filtered ? "No conversations yet. They appear here as soon as a customer writes." : "Nothing matches these filters right now."}
            </p>
          ) : (
            <ul className="space-y-px p-1.5">
              {rows.map((item) => {
                const project = projectOf(item.projectSlug);
                const href = project ? projectHref(item.href, project.slug, workspace) : inboxHref(item.href, scope);
                return (
                <InboxRow
                  key={item.key}
                  item={item}
                  project={project ? { name: project.name, color: projectColor(project.colorIndex) } : null}
                  term={filters.search}
                  compact={density === "compact"}
                  href={href}
                  active={samePath(pathname, href)}
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
                );
              })}
            </ul>
          )}
          {shown && messageSearch ? <MessageSearchNotice info={extra?.limitReached ? { ...messageSearch, limitReached: true } : messageSearch} more={nextCursor ? loadMoreMatches : null} loading={extra?.loading ?? false} /> : null}
          {shown?.truncated ? <p className="px-4 py-3 text-center text-[11px] text-[color:var(--color-subtle-foreground)]">{universal ? "Showing the most recent conversations of each project." : "Showing the 300 most recent matches."} Narrow the filters or search to reach the rest.</p> : null}
        </div>
      </aside>

      <section className={`flex min-w-0 flex-1 flex-col bg-[var(--color-surface)] ${threadOpen ? "" : "max-md:hidden"}`}>
        {openProject ? (
          <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-4 text-[12px] text-[color:var(--color-muted-foreground)]">
            <span aria-hidden className="size-2 rounded-full" style={{ background: projectColor(openProject.colorIndex) }} />
            In <span className="font-medium text-[color:var(--color-foreground)]">{openProject.name}</span>
          </div>
        ) : null}
        {universal && !threadOpen ? (
          <UniversalBoard counts={counts} projects={universal.projects} unavailable={universal.unavailable} onPick={(slug) => setProjectFilter(slug)} />
        ) : (
          children
        )}
      </section>

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

/** The fifth tab: every other view, named on the tab while one of them is on. */
function MoreViewsMenu({ views, current, counts, onPick }: { views: typeof MORE_VIEWS; current: InboxViewKey; counts: InboxCounts; onPick: (view: InboxViewKey) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  const active = views.find((v) => v.view === current) ?? null;
  return (
    <div ref={root} className="relative flex min-w-0 flex-1">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`flex w-full min-w-0 flex-col items-center gap-0.5 border-b-2 px-0.5 pb-1.5 pt-1 text-[11.5px] font-medium transition-colors ${
          active ? "border-[var(--color-accent)] text-[color:var(--color-foreground)]" : "border-transparent text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
        }`}
      >
        <MoreHorizontal className="size-4" aria-hidden />
        <span className="max-w-full truncate">{active?.label ?? "More"}</span>
      </button>
      {open ? (
        <div role="menu" className="absolute right-0 top-full z-30 mt-1 w-44 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-1 shadow-[var(--shadow-lg)]">
          {views.map((v) => {
            const n = v.count ? counts[v.count] : 0;
            return (
              <button
                key={v.view}
                type="button"
                role="menuitemradio"
                aria-checked={v.view === current}
                onClick={() => {
                  onPick(v.view);
                  setOpen(false);
                }}
                className={`flex w-full items-center justify-between gap-2 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-left text-[12.5px] hover:bg-[var(--color-neutral-bg)] ${v.view === current ? "font-medium text-[color:var(--color-foreground)]" : "text-[color:var(--color-muted-foreground)]"}`}
              >
                {v.label}
                {n > 0 ? <span className="tabular text-[11px] text-[color:var(--color-subtle-foreground)]">{n}</span> : null}
              </button>
            );
          })}
        </div>
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

function FilterSelect({ label, value, onChange, options, anyLabel = "Any" }: { label: string; value: string | null; onChange: (v: string | null) => void; options: { value: string; label: string }[]; anyLabel?: string }) {
  return (
    <label className="flex min-w-0 flex-col gap-0.5 text-[11px] text-[color:var(--color-muted-foreground)]">
      {label}
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} className="h-7 min-w-0 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 text-[12px] text-[color:var(--color-foreground)]">
        <option value="">{anyLabel}</option>
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
        {(options.collaboration || options.lifecycle) && options.people.length ? (
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
        {(options.collaboration || options.lifecycle) && options.teams.length ? (
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
        {options.autoRouting ? (
          <button
            type="button"
            disabled={none}
            onClick={() => onRun({ op: "distribute" })}
            title="Give the selected unassigned conversations to the routing pool in turn"
            className="rounded-[var(--radius-sm)] px-2 ring-1 ring-[var(--color-border)] hover:bg-[var(--color-neutral-bg)] disabled:opacity-50"
          >
            Distribute evenly
          </button>
        ) : null}
        {options.lifecycle ? (
          <>
            <button type="button" disabled={none} onClick={() => onRun({ op: "lifecycle", to: "PENDING" })} className="rounded-[var(--radius-sm)] px-2 ring-1 ring-[var(--color-border)] hover:bg-[var(--color-neutral-bg)] disabled:opacity-50">
              Pending
            </button>
            <select
              disabled={none}
              value=""
              onChange={(e) => pick(e.target.value, (v) => onRun({ op: "lifecycle", to: "SNOOZED", until: new Date(Date.now() + Number(v) * 3_600_000).toISOString() }))}
              className="h-7 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 disabled:opacity-50"
              aria-label="Snooze"
            >
              <option value="">Snooze…</option>
              <option value="1">1 hour</option>
              <option value="4">4 hours</option>
              <option value="24">1 day</option>
              <option value="168">1 week</option>
            </select>
            <button type="button" disabled={none} onClick={() => onRun({ op: "lifecycle", to: "RESOLVED" })} className="rounded-[var(--radius-sm)] px-2 ring-1 ring-[var(--color-border)] hover:bg-[var(--color-neutral-bg)] disabled:opacity-50">
              Resolve
            </button>
            <button type="button" disabled={none} onClick={() => onRun({ op: "lifecycle", to: "OPEN" })} className="rounded-[var(--radius-sm)] px-2 ring-1 ring-[var(--color-border)] hover:bg-[var(--color-neutral-bg)] disabled:opacity-50">
              Reopen
            </button>
          </>
        ) : (
          <>
            <button type="button" disabled={none} onClick={() => onRun({ op: "status", status: "CLOSED" })} className="rounded-[var(--radius-sm)] px-2 ring-1 ring-[var(--color-border)] hover:bg-[var(--color-neutral-bg)] disabled:opacity-50">
              Close
            </button>
            <button type="button" disabled={none} onClick={() => onRun({ op: "status", status: "OPEN" })} className="rounded-[var(--radius-sm)] px-2 ring-1 ring-[var(--color-border)] hover:bg-[var(--color-neutral-bg)] disabled:opacity-50">
              Reopen
            </button>
          </>
        )}
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

function InboxRow({ item, project, href, term, active, compact, selecting, selected, onToggle }: { item: InboxItem; project: { name: string; color: string } | null; href: string; term: string; active: boolean; compact: boolean; selecting: boolean; selected: boolean; onToggle: () => void }) {
  const avatar = conversationAvatar(item.key, item.title);
  const rowClass = `group/row relative flex w-full gap-2.5 rounded-[var(--radius-lg)] px-2.5 ${compact ? "py-1.5" : "py-2.5"} text-left transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-focus-ring)] ${
    active || selected ? "bg-[var(--color-accent-bg)]" : "hover:bg-[var(--color-neutral-bg)]"
  }`;
  const meta = compact
    ? null
    : {
        status: item.lifecycleStatus ? (item.lifecycleStatus !== "OPEN" ? CONVERSATION_STATUS_LABELS[item.lifecycleStatus] : null) : item.status === "CLOSED" ? "Closed" : null,
        assignee: item.assigneeName ? (item.assignedToMe ? "You" : item.assigneeName) : null,
      };
  const hasMeta = meta && (meta.status || meta.assignee || item.teamName || item.tags.length > 0 || item.connectionProblem);

  const body = (
    <>
      {selecting ? <span className="flex shrink-0 items-center">{selected ? <CheckSquare className="size-4 text-[color:var(--color-accent)]" aria-hidden /> : <Square className="size-4 text-[color:var(--color-subtle-foreground)]" aria-hidden />}</span> : null}
      <span className="relative shrink-0 self-start">
        <span aria-hidden style={{ background: avatar.background, color: avatar.color }} className={`flex ${compact ? "size-8 text-[11px]" : "size-10 text-[12.5px]"} items-center justify-center rounded-full font-semibold tracking-[-0.01em]`}>
          {item.isGroup ? <Users className={compact ? "size-3.5" : "size-4.5"} aria-hidden /> : avatar.initials}
        </span>
        <span className={`absolute -bottom-0.5 -right-0.5 flex rounded-full p-px ${active || selected ? "bg-[var(--color-accent-bg)]" : "bg-[var(--color-surface)]"}`}>
          <ChannelMark channel={item.channel} size="xs" />
        </span>
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1">
            {item.priority === "HIGH" || item.priority === "URGENT" ? <Flag className={`size-3 shrink-0 ${PRIORITY_STYLE[item.priority]}`} aria-label={`${CONVERSATION_PRIORITY_LABEL[item.priority]} priority`} /> : null}
            <span className={`truncate text-[13px] text-[color:var(--color-foreground)] ${item.unread ? "font-semibold" : "font-medium"}`} dir="auto" title={item.via}>
              {item.title}
            </span>
            {item.aiOn ? <Bot className="size-3 shrink-0 text-[color:var(--color-accent-fg)]" aria-label="AI answers here" /> : null}
          </span>
          <span className={`tabular shrink-0 text-[11px] ${item.unread ? "font-medium text-[color:var(--color-accent-fg)]" : "text-[color:var(--color-subtle-foreground)]"}`} suppressHydrationWarning>
            {relativeTime(item.lastMessageAt)}
          </span>
        </span>
        <span className="mt-0.5 flex items-center gap-2">
          <span className={`min-w-0 flex-1 truncate text-[12.5px] ${item.unread ? "font-medium text-[color:var(--color-foreground)]" : "text-[color:var(--color-muted-foreground)]"}`} dir="auto">
            {item.lastSendFailed ? (
              <span className="mr-1 inline-flex items-center gap-0.5 font-medium text-[color:var(--color-danger-fg)]">
                <AlertTriangle className="size-3" aria-hidden />
                Not sent ·
              </span>
            ) : null}
            {item.messageMatch ? (
              <>
                <Search className="mr-1 inline size-3 align-[-2px] text-[color:var(--color-subtle-foreground)]" aria-label="Matching message" />
                <Highlighted text={item.messageMatch.snippet} term={term} />
              </>
            ) : item.preview ? (
              <>
                {item.lastMessageOutgoing ? <span className="text-[color:var(--color-subtle-foreground)]">You: </span> : null}
                {item.preview}
              </>
            ) : (
              <span className="italic text-[color:var(--color-subtle-foreground)]">No messages yet</span>
            )}
          </span>
          {item.needsReply && item.waitingSince ? (
            <span
              className="tabular shrink-0 text-[11px] font-medium text-[color:var(--color-warning-fg)]"
              title={`Waiting for a reply since ${new Date(item.waitingSince).toLocaleString("en-GB", { timeZone: "Asia/Dhaka" })}`}
              suppressHydrationWarning
            >
              <span className="sr-only">Waiting for a reply for </span>
              {waitedFor(item.waitingSince)}
            </span>
          ) : null}
          {item.unread ? (
            <>
              <span aria-hidden className="size-2 shrink-0 rounded-full bg-[var(--color-accent)]" />
              <span className="sr-only">Unread. A customer is waiting.</span>
            </>
          ) : null}
        </span>
        {hasMeta || project ? (
          <span className="mt-1 flex items-center gap-1 overflow-hidden whitespace-nowrap">
            {project ? (
              <span className="inline-flex min-w-0 max-w-[10rem] shrink-0 items-center gap-1 rounded-[var(--radius-xs)] px-1.5 py-px text-[10.5px] font-medium text-[color:var(--color-foreground)]" style={{ background: `color-mix(in srgb, ${project.color} 16%, transparent)` }}>
                <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: project.color }} />
                <span className="truncate">{project.name}</span>
              </span>
            ) : null}
            {meta?.status ? <Chip>{meta.status}</Chip> : null}
            {meta?.assignee ? (
              <Chip>
                <UserRound className="size-2.5" aria-hidden />
                {meta.assignee}
              </Chip>
            ) : null}
            {meta && item.teamName ? <Chip>{item.teamName}</Chip> : null}
            {(meta ? item.tags.slice(0, 2) : []).map((t) => (
              <span key={t} className="rounded-[var(--radius-xs)] bg-[var(--color-info-bg)] px-1.5 py-px text-[10.5px] text-[color:var(--color-info-fg)]">
                #{t}
              </span>
            ))}
            {meta && item.tags.length > 2 ? <span className="text-[10.5px] text-[color:var(--color-subtle-foreground)]">+{item.tags.length - 2}</span> : null}
            {meta && item.connectionProblem ? (
              <span className="inline-flex items-center gap-0.5 text-[10.5px] font-medium text-[color:var(--color-danger-fg)]" title={item.connectionProblem}>
                <AlertTriangle className="size-2.5" aria-hidden />
                Can&apos;t reply
              </span>
            ) : null}
          </span>
        ) : null}
      </span>
    </>
  );

  return (
    <li className="relative">
      {selecting ? (
        // A button while selecting, never a link with an intercepted click: middle-click must not navigate away and lose the selection.
        <button type="button" onClick={onToggle} aria-pressed={selected} className={rowClass}>
          {body}
        </button>
      ) : (
        <Link href={item.messageMatch ? `${href}${href.includes("?") ? "&" : "?"}msg=${encodeURIComponent(item.messageMatch.messageId)}` : href} aria-current={active ? "page" : undefined} className={rowClass}>
          {body}
        </Link>
      )}
    </li>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return <span className="inline-flex items-center gap-0.5 rounded-[var(--radius-xs)] bg-[var(--color-neutral-bg)] px-1.5 py-px text-[10.5px] text-[color:var(--color-neutral-fg)]">{children}</span>;
}

/** The term marked inside a snippet. Plain text only: the snippet is never rendered as HTML. */
function Highlighted({ text, term }: { text: string; term: string }) {
  const t = term.trim();
  const at = t ? text.toLocaleLowerCase().indexOf(t.toLocaleLowerCase()) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-sm bg-[var(--color-warning-bg)] px-0.5 text-[color:var(--color-foreground)]">{text.slice(at, at + t.length)}</mark>
      {text.slice(at + t.length)}
    </>
  );
}

/** What the WhatsApp message-text search covered, under the results. */
function MessageSearchNotice({ info, more, loading }: { info: MessageSearchInfo; more: (() => void) | null; loading: boolean }) {
  const line = info.tooShort
    ? "Type 3 or more characters to search WhatsApp message text too. Names are searched already."
    : info.timedOut
      ? "Searching WhatsApp message text took too long and was stopped. Add another word to narrow it. Names are still searched."
      : info.limitReached && !more
        ? "That is as many message matches as one search shows. Add another word to narrow it."
        : "Names, and WhatsApp message text across the whole history.";
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-3 text-center text-[11px] text-[color:var(--color-subtle-foreground)]" role="status">
      <p className={info.timedOut ? "text-[color:var(--color-warning-fg)]" : undefined}>{line}</p>
      {more ? (
        <Button type="button" size="sm" variant="secondary" onClick={more} disabled={loading}>
          {loading ? "Searching…" : "More message matches"}
        </Button>
      ) : null}
    </div>
  );
}
