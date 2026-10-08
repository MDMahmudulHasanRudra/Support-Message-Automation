"use client";

import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import {
  Archive,
  BellRing,
  Check,
  CheckSquare,
  ChevronDown,
  EyeOff,
  Inbox,
  Loader2,
  MailOpen,
  Pin,
  PinOff,
  Rows3,
  Rows4,
  Search,
  Settings2,
  Smartphone,
  Star,
  Tag,
  TextSearch,
  X,
} from "lucide-react";
import Link from "@/components/ProjectLink";
import { usePathname } from "next/navigation";
import { stripProjectPrefix } from "@/lib/projectPaths";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { useToast } from "@/components/ui";
import {
  setChatArchived,
  setChatCategory,
  setChatPinned,
  setChatReviewed,
  type ChatOrganisationResult,
} from "@/server/actions/chatOrganisation";
import { chatAccountSwitchTarget, listConversationView, searchConversations } from "@/server/actions/chatSearch";
import type { ChatAccountOption, ChatCategorySummary, ConversationCounts, ConversationSummary, ConversationView } from "@/server/chatInbox";
import { CategoryManager } from "./CategoryManager";
import { MOOD_EMOJI, MOOD_LABELS, MOOD_LEVEL } from "@support-automation/shared";
import { conversationAvatar } from "./avatar";
import { categoryDotClass } from "./categoryColors";
import { accountStatusTone, rememberChatAccount } from "./chatAccounts";

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

/** "All", "awaiting a reply", "seen but unanswered", or a category. The archive is its own page. */
type Filter = ConversationView;

function filterKey(filter: Filter): string {
  return filter.kind === "category" ? `category:${filter.id}` : filter.kind;
}

function viewFromKey(key: string): Filter {
  if (key.startsWith("category:")) return { kind: "category", id: key.slice("category:".length) };
  if (key === "waiting" || key === "seen-unanswered") return { kind: key };
  return { kind: "all" };
}

function matchesFilter(conversation: ConversationSummary, filter: Filter): boolean {
  switch (filter.kind) {
    case "waiting":
      return conversation.awaitingReply;
    case "seen-unanswered":
      return conversation.isUnanswered && !conversation.awaitingReply;
    case "category":
      return conversation.categoryId === filter.id;
    default:
      return true;
  }
}

/** Row height preference. Stored per browser: it is how one person likes to read, not team state. */
const DENSITY_KEY = "chat-list-density";

/**
 * The density preference as an external store rather than state seeded from an effect.
 *
 * `localStorage` cannot be read while rendering on the server, so the obvious version — default
 * false, then correct it in an effect — renders every row at the wrong height for one frame and
 * costs a second render pass on every mount. `useSyncExternalStore` is built for exactly this
 * shape: the server snapshot is the safe default, and React re-reads the real value after
 * hydration without a cascading render.
 */
const densityListeners = new Set<() => void>();
let densityCache: boolean | null = null;

function densitySnapshot(): boolean {
  // Cached because useSyncExternalStore calls this on every render and compares by identity; a
  // fresh read each time is both a needless storage hit and a loop risk.
  if (densityCache === null) {
    try {
      densityCache = window.localStorage.getItem(DENSITY_KEY) === "compact";
    } catch {
      densityCache = false; // private mode, or storage disabled
    }
  }
  return densityCache;
}

/** Comfortable is the server-rendered default: the safer of the two if storage never answers. */
function densityServerSnapshot(): boolean {
  return false;
}

function subscribeDensity(onChange: () => void): () => void {
  densityListeners.add(onChange);
  return () => densityListeners.delete(onChange);
}

function writeDensity(compact: boolean): void {
  densityCache = compact;
  try {
    window.localStorage.setItem(DENSITY_KEY, compact ? "compact" : "comfortable");
  } catch {
    /* see above */
  }
  densityListeners.forEach((listener) => listener());
}

/**
 * The chat workspace for one WhatsApp account, rendered once by the account layout so the list keeps
 * its scroll position as you move between conversations.
 *
 * The hierarchy is the order an operator reaches for things: WHICH ACCOUNT (the selector, first and
 * largest — every reply goes out from it), then search, then the filters, then the list. They sit in
 * a header across the whole workspace rather than squeezed into the list's narrow column, where the
 * filters used to be an 11px rail. The header is two rows and no more, so the conversation keeps its
 * height.
 *
 * Counts are the account's real totals from the server — "All 742" when there are 742, even though
 * the list renders the 300 most recently active. A filter whose total exceeds what was loaded fetches
 * its complete list from the server, so "Waiting 18" opens eighteen conversations, not the twelve that
 * happened to be among the loaded 300.
 *
 * Selection is a mode rather than always-on checkboxes: this list is read far more often than it is
 * reorganised. It belongs to one account and one filter — switching account remounts the whole
 * workspace, and changing the filter clears it — so a bulk action can only ever reach what is on
 * screen. The server re-checks the account anyway.
 */
export function ChatWorkspace({
  account,
  accounts,
  conversations,
  counts,
  categories,
  children,
}: {
  account: ChatAccountOption;
  accounts: ChatAccountOption[];
  conversations: ConversationSummary[];
  counts: ConversationCounts;
  categories: ChatCategorySummary[];
  children: React.ReactNode;
}) {
  const pathname = stripProjectPrefix(usePathname());
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [filter, setFilterState] = useState<Filter>({ kind: "all" });
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [managingCategories, setManagingCategories] = useState(false);
  const compact = useSyncExternalStore(subscribeDensity, densitySnapshot, densityServerSnapshot);
  const [cursor, setCursor] = useState(-1);
  /**
   * The last completed remote search, stored WITH the query it answered, so "are these results
   * current?" is derived rather than tracked: a stale response can never be shown under a newer query.
   */
  const [remote, setRemote] = useState<{ query: string; matches: ConversationSummary[] }>({ query: "", matches: [] });
  /** A filter's complete list from the server, stored with the filter it answered. */
  const [viewRows, setViewRows] = useState<{ key: string; rows: ConversationSummary[] }>({ key: "", rows: [] });
  const [pending, startTransition] = useTransition();
  const { showToast } = useToast();
  const searchRef = useRef<HTMLInputElement>(null);

  const base = `/chat/account/${account.id}`;
  const rest = pathname.startsWith(`${base}/`) ? pathname.slice(base.length + 1) : "";
  const activeGroupId = rest && rest !== "archived" ? rest.split("/")[0] : undefined;
  /** The inbox page itself — on a phone the list IS this page; elsewhere the conversation is. */
  const onIndex = pathname === base || pathname === `${base}/`;

  // Remembered for /chat's next visit. The URL stays the authority on which account this tab is in.
  useEffect(() => rememberChatAccount(account.id), [account.id]);

  const toggleDensity = useCallback(() => writeDensity(!densitySnapshot()), []);
  const categoryById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);

  const key = filterKey(filter);
  const totalFor = (f: Filter): number =>
    f.kind === "all"
      ? counts.total
      : f.kind === "waiting"
        ? counts.waiting
        : f.kind === "seen-unanswered"
          ? counts.seenUnanswered
          : (categoryById.get(f.id)?.count ?? 0);

  const loadedMatches = useMemo(() => conversations.filter((c) => matchesFilter(c, filter)), [conversations, filter]);
  /** The loaded 300 do not hold every row of this filter, so its complete list comes from the server. */
  const incomplete = filter.kind !== "all" && loadedMatches.length < totalFor(filter);

  // Refetched whenever the layout refreshes (every four seconds) while such a filter is open, so the
  // list keeps up with new messages exactly as the loaded list does. Nothing is set synchronously:
  // the only write is the answer, stored with the filter it belongs to.
  useEffect(() => {
    if (!incomplete) return;
    let cancelled = false;
    listConversationView(account.id, viewFromKey(key))
      .then((rows) => {
        if (!cancelled) setViewRows({ key, rows });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [incomplete, key, conversations, account.id]);

  const viewLoading = incomplete && viewRows.key !== key;
  const baseRows = incomplete && viewRows.key === key ? viewRows.rows : loadedMatches;

  const needle = query.trim();
  const filtered = useMemo(() => {
    const lower = needle.toLowerCase();
    if (!lower) return baseRows;
    return baseRows.filter((c) => `${c.name} ${c.lastMessagePreview ?? ""}`.toLowerCase().includes(lower));
  }, [baseRows, needle]);

  /** Long enough to search, and the stored answer is for a different query. Derived, never set. */
  const searching = needle.length >= 2 && remote.query !== needle;

  const elsewhere = useMemo(() => {
    if (remote.query !== needle || remote.matches.length === 0) return [];
    const onScreen = new Set(baseRows.map((c) => c.id));
    // Search reaches every group of the account; within a filter it stays inside that filter.
    return remote.matches.filter((match) => !onScreen.has(match.id) && matchesFilter(match, filter));
  }, [remote, needle, baseRows, filter]);

  /** Everything a bulk action could reach right now: what the filter and search show, nothing else. */
  const selectableIds = useMemo(() => [...filtered.map((c) => c.id), ...elsewhere.map((c) => c.id)], [filtered, elsewhere]);

  const pinnedCount = useMemo(() => conversations.filter((c) => c.isPinned).length, [conversations]);
  const { pinnedRows, otherRows, navigable } = useMemo(() => {
    const split = filter.kind === "all" && !needle && pinnedCount > 0;
    const pinned = split ? filtered.filter((c) => c.isPinned) : [];
    const others = split ? filtered.filter((c) => !c.isPinned) : filtered;
    // The keyboard walks what is on screen, in the order it is on screen.
    return { pinnedRows: pinned, otherRows: others, navigable: [...pinned, ...others, ...elsewhere] };
  }, [filtered, filter, needle, pinnedCount, elsewhere]);

  // Clamped at read time rather than reset in an effect: typing shrinks the list under a cursor
  // that was valid a keystroke ago.
  const activeCursor = cursor < 0 ? -1 : Math.min(cursor, navigable.length - 1);

  const selectedIds = [...selected];
  const byId = useMemo(() => new Map([...conversations, ...baseRows, ...elsewhere].map((c) => [c.id, c])), [conversations, baseRows, elsewhere]);
  const allSelectedPinned = selectedIds.length > 0 && selectedIds.every((id) => byId.get(id)?.isPinned);

  /** A new filter is a new list: anything selected under the old one is not on screen any more. */
  function setFilter(next: Filter) {
    setFilterState(next);
    setSelected(new Set());
    setCursor(-1);
  }

  // "/" to search, from anywhere on the page — never while typing in a field.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // Reaching past the loaded 300: a debounced server search over every group of THIS account.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      searchConversations(account.id, trimmed)
        .then((matches) => {
          if (!cancelled) setRemote({ query: trimmed, matches });
        })
        .catch(() => {
          if (!cancelled) setRemote({ query: trimmed, matches: [] });
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, account.id]);

  function onSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((current) => Math.min(current + 1, navigable.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter" && navigable[activeCursor]) {
      event.preventDefault();
      router.push(`${base}/${navigable[activeCursor]!.id}`);
    } else if (event.key === "Escape") {
      if (query) {
        setQuery("");
        setCursor(-1);
      } else {
        searchRef.current?.blur();
      }
    }
  }

  function toggleSelected(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function exitSelection() {
    setSelecting(false);
    setSelected(new Set());
  }

  /** Every bulk action reports what it actually did, then leaves selection mode. */
  function runBulk(label: string, action: () => Promise<ChatOrganisationResult>) {
    startTransition(async () => {
      const result = await action();
      if (result.error) {
        showToast({ tone: "danger", title: result.error });
        return;
      }
      const updated = result.updated ?? 0;
      const notes = [
        result.unchanged ? `${result.unchanged} already ${label}.` : null,
        result.outsideAccount ? `${result.outsideAccount} belong to another account and were left alone.` : null,
      ].filter(Boolean);
      showToast({
        tone: "success",
        title: `${updated} conversation${updated === 1 ? "" : "s"} ${label}`,
        description: notes.length ? notes.join(" ") : undefined,
      });
      exitSelection();
    });
  }

  const rowProps = (conversation: ConversationSummary, index: number) => ({
    conversation,
    href: `${base}/${conversation.id}`,
    category: conversation.categoryId ? categoryById.get(conversation.categoryId) : undefined,
    active: conversation.id === activeGroupId,
    cursored: index === activeCursor,
    compact,
    selecting,
    selected: selected.has(conversation.id),
    onToggle: () => toggleSelected(conversation.id),
  });

  const allCapped = filter.kind === "all" && !needle && counts.total > conversations.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* ── Account, search, filters ─────────────────────────────────────────────────────────── */}
      <div
        className={`${onIndex ? "flex" : "hidden md:flex"} shrink-0 flex-col gap-2.5 border-b border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-3 py-3 sm:px-4`}
      >
        <div className="flex flex-wrap items-center gap-2">
          <AccountSelector
            account={account}
            accounts={accounts}
            onSwitch={(targetId) =>
              startTransition(async () => {
                const target = await chatAccountSwitchTarget(targetId, activeGroupId ?? null);
                rememberChatAccount(targetId);
                router.push(target ?? `/chat/account/${targetId}`);
              })
            }
            switching={pending}
          />

          <div className="relative min-w-[12rem] flex-1">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[color:var(--color-muted-foreground)]"
              aria-hidden
            />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                // Back to the top on every keystroke: after filtering, "the third one down" is a
                // different conversation than it was.
                setCursor(-1);
              }}
              onKeyDown={onSearchKeyDown}
              placeholder={`Search ${account.label} conversations`}
              aria-label={`Search ${account.label} conversations`}
              aria-keyshortcuts="/"
              className="h-10 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] pl-9 pr-14 text-[13px] text-[color:var(--color-foreground)] outline-none transition-[border-color,box-shadow] duration-[var(--duration-fast)] placeholder:text-[color:var(--color-muted-foreground)] focus-visible:border-[var(--color-primary)] focus-visible:ring-[3px] focus-visible:ring-[var(--color-primary)]/12"
            />
            {query ? (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  setCursor(-1);
                  searchRef.current?.focus();
                }}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 flex size-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-[var(--radius-xs)] text-[color:var(--color-muted-foreground)] transition-colors duration-[var(--duration-fast)] hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)]"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            ) : (
              <kbd
                aria-hidden
                className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded-[var(--radius-xs)] border border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-1.5 py-0.5 text-[10px] font-medium text-[color:var(--color-subtle-foreground)]"
              >
                /
              </kbd>
            )}
          </div>

          <button
            type="button"
            onClick={toggleDensity}
            aria-pressed={compact}
            title={compact ? "Switch to comfortable rows" : "Switch to compact rows"}
            aria-label={compact ? "Switch to comfortable rows" : "Switch to compact rows"}
            className="flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] text-[color:var(--color-muted-foreground)] transition-[border-color,color,transform] duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:border-[var(--color-border-strong)] hover:text-[color:var(--color-foreground)] active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
          >
            {compact ? <Rows3 className="size-4" aria-hidden /> : <Rows4 className="size-4" aria-hidden />}
          </button>

          <Link
            href={`${base}/archived`}
            className="flex h-10 shrink-0 items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[12px] font-medium text-[color:var(--color-muted-foreground)] transition-[border-color,color] duration-[var(--duration-fast)] hover:border-[var(--color-border-strong)] hover:text-[color:var(--color-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
          >
            <Archive className="size-3.5" aria-hidden />
            Archived
          </Link>
        </div>

        {/* One row of filters, scrolled sideways rather than wrapped, so the header never grows
            downward into the conversation's space however many categories the team keeps. */}
        <div
          className="-mx-1 flex items-center gap-1.5 overflow-x-auto px-1 pb-0.5 [scrollbar-width:thin]"
          role="group"
          aria-label="Filter conversations"
        >
          <FilterChip active={filter.kind === "all"} onClick={() => setFilter({ kind: "all" })}>
            All
            <ChipCount>{counts.total}</ChipCount>
          </FilterChip>
          <FilterChip tone="warning" active={filter.kind === "waiting"} onClick={() => setFilter({ kind: "waiting" })}>
            <Inbox className="size-3.5" aria-hidden />
            Waiting
            <ChipCount>{counts.waiting}</ChipCount>
          </FilterChip>
          {/* Separate from "waiting" on purpose: conversations somebody has already opened and the
              customer still has no answer. They leave the waiting count by design — this is where
              they went, so they cannot quietly disappear. */}
          {counts.seenUnanswered > 0 || filter.kind === "seen-unanswered" ? (
            <FilterChip active={filter.kind === "seen-unanswered"} onClick={() => setFilter({ kind: "seen-unanswered" })}>
              <EyeOff className="size-3.5" aria-hidden />
              Seen, unanswered
              <ChipCount>{counts.seenUnanswered}</ChipCount>
            </FilterChip>
          ) : null}

          {categories.length ? <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-[var(--color-border-strong)]" /> : null}

          {categories.map((category) => (
            <FilterChip
              key={category.id}
              active={filter.kind === "category" && filter.id === category.id}
              onClick={() => setFilter({ kind: "category", id: category.id })}
            >
              <span className={`size-2 shrink-0 rounded-full ${categoryDotClass(category.color)}`} aria-hidden />
              {category.name}
              <ChipCount>{category.count}</ChipCount>
            </FilterChip>
          ))}

          <button
            type="button"
            onClick={() => setManagingCategories(true)}
            title="Manage categories"
            className="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-dashed border-[var(--color-border-strong)] px-3 text-[12px] font-medium text-[color:var(--color-muted-foreground)] transition-[border-color,color,transform] duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:border-[var(--color-primary)] hover:text-[color:var(--color-foreground)] active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
          >
            <Settings2 className="size-3.5" aria-hidden />
            {categories.length ? "Categories" : "Add a category"}
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* ── The account's conversations ─────────────────────────────────────────────────────── */}
        <aside
          aria-label={`${account.label} conversations`}
          className={`${onIndex ? "flex" : "hidden"} w-full shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface-sunken)] md:flex md:w-[21rem]`}
        >
          <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--color-border)] px-3 py-1.5 text-[12px]">
            <ToolbarButton onClick={() => (selecting ? exitSelection() : setSelecting(true))} pressed={selecting}>
              <CheckSquare className="size-3.5" aria-hidden />
              {selecting ? "Done" : "Select"}
            </ToolbarButton>

            {selecting && selectableIds.length > 0 ? (
              <>
                <ToolbarButton onClick={() => setSelected(new Set(selectableIds))} disabled={selected.size === selectableIds.length}>
                  Select all {selectableIds.length}
                </ToolbarButton>
                {selected.size > 0 ? <ToolbarButton onClick={() => setSelected(new Set())}>Clear</ToolbarButton> : null}
              </>
            ) : null}

            {/* Scoped to the waiting filter on purpose. "Mark everything read" from All would be a
                single click that silences the entire inbox. */}
            {!selecting && filter.kind === "waiting" && filtered.length > 0 ? (
              <ToolbarButton
                disabled={pending}
                onClick={() => {
                  const ids = filtered.map((c) => c.id);
                  runBulk("marked as read", () => setChatReviewed(account.id, ids, true));
                  setFilter({ kind: "all" });
                }}
              >
                <MailOpen className="size-3.5" aria-hidden />
                Mark all {filtered.length} read
              </ToolbarButton>
            ) : null}

            <span className="tabular ml-auto shrink-0 text-[11px] text-[color:var(--color-muted-foreground)]" aria-live="polite">
              {selecting
                ? `${selected.size} of ${selectableIds.length} selected`
                : viewLoading
                  ? "Loading…"
                  : `${(filtered.length + elsewhere.length).toLocaleString("en-US")} shown`}
            </span>
          </div>

          {/* The bulk bar appears between the toolbar and the list, so the rows it acts on stay
              visible while you choose what to do to them. */}
          {selecting && selected.size > 0 ? (
            <div className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-primary)]/[0.06] px-3 py-2.5">
              <p className="mb-2 text-[12px] font-semibold text-[color:var(--color-foreground)]">
                {selected.size} selected <span className="font-normal text-[color:var(--color-muted-foreground)]">· {account.label}</span>
              </p>
              <div className="flex flex-wrap gap-1.5">
                <BulkButton
                  disabled={pending}
                  onClick={() =>
                    runBulk(allSelectedPinned ? "unpinned" : "pinned", () => setChatPinned(account.id, selectedIds, !allSelectedPinned))
                  }
                >
                  {allSelectedPinned ? <PinOff className="size-3" aria-hidden /> : <Pin className="size-3" aria-hidden />}
                  {allSelectedPinned ? "Unpin" : "Pin"}
                </BulkButton>

                {categories.map((category) => (
                  <BulkButton
                    key={category.id}
                    disabled={pending}
                    onClick={() => runBulk(`moved to ${category.name}`, () => setChatCategory(account.id, selectedIds, category.id))}
                  >
                    <span className={`size-2 shrink-0 rounded-full ${categoryDotClass(category.color)}`} aria-hidden />
                    {category.name}
                  </BulkButton>
                ))}

                <BulkButton disabled={pending} onClick={() => runBulk("uncategorised", () => setChatCategory(account.id, selectedIds, null))}>
                  <Tag className="size-3" aria-hidden />
                  Remove category
                </BulkButton>

                {/* Safe in bulk because the mark is a timestamp — every one of these returns the
                    moment its customer writes again. */}
                <BulkButton disabled={pending} onClick={() => runBulk("marked as read", () => setChatReviewed(account.id, selectedIds, true))}>
                  <MailOpen className="size-3" aria-hidden />
                  Mark as read
                </BulkButton>
                <BulkButton disabled={pending} onClick={() => runBulk("marked as waiting", () => setChatReviewed(account.id, selectedIds, false))}>
                  <BellRing className="size-3" aria-hidden />
                  Mark as waiting
                </BulkButton>
                {/* Not destructive: archiving hides a conversation from the inbox, monitoring and AI
                    carry on, and the archive puts it back in one click. */}
                <BulkButton disabled={pending} onClick={() => runBulk("archived", () => setChatArchived(account.id, selectedIds, true))}>
                  <Archive className="size-3" aria-hidden />
                  Archive
                </BulkButton>
              </div>
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {filtered.length === 0 && elsewhere.length === 0 && !searching && !viewLoading ? (
              <EmptyList
                accountLabel={account.label}
                total={counts.total}
                filter={filter}
                query={query}
                onClear={() => {
                  setQuery("");
                  setFilter({ kind: "all" });
                }}
              />
            ) : (
              <>
                {pinnedRows.length > 0 ? (
                  <>
                    <SectionLabel icon={<Pin className="size-3" aria-hidden />}>Pinned</SectionLabel>
                    <ul>
                      {pinnedRows.map((conversation, index) => (
                        <Row key={conversation.id} {...rowProps(conversation, index)} />
                      ))}
                    </ul>
                    <SectionLabel>All conversations</SectionLabel>
                  </>
                ) : null}

                <ul>
                  {otherRows.map((conversation, index) => (
                    <Row key={conversation.id} {...rowProps(conversation, pinnedRows.length + index)} />
                  ))}
                </ul>

                {viewLoading ? (
                  <p className="flex items-center gap-1.5 px-3.5 py-2.5 text-[11px] text-[color:var(--color-subtle-foreground)]" aria-live="polite">
                    <Loader2 className="size-3 animate-spin" aria-hidden />
                    Loading the rest of this filter…
                  </p>
                ) : null}

                {elsewhere.length > 0 ? (
                  <>
                    <SectionLabel icon={<TextSearch className="size-3" aria-hidden />}>Elsewhere in {account.label}</SectionLabel>
                    <ul>
                      {elsewhere.map((conversation, index) => (
                        <Row key={conversation.id} {...rowProps(conversation, pinnedRows.length + otherRows.length + index)} />
                      ))}
                    </ul>
                  </>
                ) : null}

                {searching ? (
                  <p className="px-3.5 py-2.5 text-[11px] text-[color:var(--color-subtle-foreground)]" aria-live="polite">
                    Searching every group of {account.label}…
                  </p>
                ) : null}

                {allCapped ? (
                  <p className="border-t border-[var(--color-border)] px-3.5 py-3 text-[11px] leading-relaxed text-[color:var(--color-subtle-foreground)]">
                    Showing the {conversations.length.toLocaleString("en-US")} most recently active of{" "}
                    {counts.total.toLocaleString("en-US")} groups. Search and the filters reach every group of this account.
                  </p>
                ) : null}
              </>
            )}
          </div>
        </aside>

        <div className={`${onIndex ? "hidden md:flex" : "flex"} min-w-0 flex-1 flex-col`}>{children}</div>
      </div>

      <CategoryManager open={managingCategories} onClose={() => setManagingCategories(false)} categories={categories} />
    </div>
  );
}

/**
 * The account everything below belongs to. Large, first, and always showing the number and its
 * connection, because a reply goes out from it. With one account it is a plain label; with several it
 * opens a list.
 */
function AccountSelector({
  account,
  accounts,
  onSwitch,
  switching,
}: {
  account: ChatAccountOption;
  accounts: ChatAccountOption[];
  onSwitch: (accountId: string) => void;
  switching: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const tone = accountStatusTone(account.status);
  const multiple = accounts.length > 1;

  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const face = (
    <>
      <span className="flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--color-primary)] text-[var(--color-on-primary)]">
        <Smartphone className="size-3.5" aria-hidden />
      </span>
      <span className="min-w-0 text-left">
        <span className="block text-[10px] font-medium uppercase tracking-[0.06em] text-[color:var(--color-muted-foreground)]">WhatsApp account</span>
        <span className="flex items-center gap-1.5 text-[13px] font-semibold leading-tight text-[color:var(--color-foreground)]">
          <span className="truncate">{account.label}</span>
          <span className={`size-1.5 shrink-0 rounded-full ${tone.dot}`} title={tone.label} aria-hidden />
          <span className="sr-only">{tone.label}</span>
        </span>
      </span>
    </>
  );

  if (!multiple) {
    return (
      <div className="flex h-10 max-w-[16rem] shrink-0 items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 pr-3">
        {face}
      </div>
    );
  }

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={switching}
        className="flex h-10 max-w-[18rem] cursor-pointer items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-primary)]/45 bg-[var(--color-surface)] px-1.5 pr-2.5 shadow-[var(--shadow-xs)] transition-[border-color,box-shadow,transform] duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:border-[var(--color-primary)] active:translate-y-px disabled:cursor-wait disabled:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
      >
        {face}
        {switching ? (
          <Loader2 className="ml-1 size-3.5 shrink-0 animate-spin text-[color:var(--color-muted-foreground)]" aria-hidden />
        ) : (
          <ChevronDown className={`ml-1 size-4 shrink-0 text-[color:var(--color-muted-foreground)] transition-transform duration-[var(--duration-fast)] ${open ? "rotate-180" : ""}`} aria-hidden />
        )}
      </button>

      {open ? (
        <ul
          role="listbox"
          aria-label="WhatsApp accounts"
          className="absolute left-0 top-[calc(100%+6px)] z-30 w-[19rem] overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-[var(--shadow-lg)]"
        >
          {accounts.map((option) => {
            const optionTone = accountStatusTone(option.status);
            const current = option.id === account.id;
            return (
              <li key={option.id} role="option" aria-selected={current}>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    if (!current) onSwitch(option.id);
                  }}
                  className={`flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left transition-colors duration-[var(--duration-fast)] hover:bg-[var(--color-neutral-bg)] focus-visible:bg-[var(--color-neutral-bg)] focus-visible:outline-none ${current ? "bg-[var(--color-neutral-bg)]" : ""}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-[13px] font-medium text-[color:var(--color-foreground)]">
                      <span className="truncate">{option.label}</span>
                      {option.isPrimary ? <Star className="size-3 shrink-0 fill-current text-[color:var(--color-warning)]" aria-label="Primary" /> : null}
                    </span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-[color:var(--color-muted-foreground)]">
                      <span className="inline-flex items-center gap-1">
                        <span className={`size-1.5 rounded-full ${optionTone.dot}`} aria-hidden />
                        {optionTone.label}
                      </span>
                      {option.phoneNumber ? <span className="tabular">+{option.phoneNumber.replace(/^\+/, "")}</span> : null}
                      <span className="tabular">{option.groupCount.toLocaleString("en-US")} groups</span>
                    </span>
                  </span>
                  {current ? <Check className="size-4 shrink-0 text-[color:var(--color-primary)]" aria-hidden /> : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function EmptyList({
  accountLabel,
  total,
  filter,
  query,
  onClear,
}: {
  accountLabel: string;
  total: number;
  filter: Filter;
  query: string;
  onClear: () => void;
}) {
  const message =
    total === 0
      ? `No chats found for ${accountLabel}. Run a group sync on WhatsApp Accounts once it is connected and in groups.`
      : query.trim()
        ? `No ${accountLabel} group matches “${query}”${filter.kind === "all" ? "" : " in this filter"}.`
        : filter.kind === "seen-unanswered"
          ? "Nothing has been seen and left unanswered."
          : filter.kind === "waiting"
            ? "Nothing is waiting on a reply."
            : filter.kind === "category"
              ? "No groups match the selected category. Use Select to move conversations into it."
              : `No chats found for ${accountLabel}.`;

  // When the emptiness is something the reader caused, the way back is one button.
  const recoverable = total > 0 && (query.trim().length > 0 || filter.kind !== "all");

  return (
    <div className="px-6 py-12 text-center">
      <span
        aria-hidden
        className="mx-auto flex size-9 items-center justify-center rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] text-[color:var(--color-subtle-foreground)] shadow-[var(--shadow-xs),var(--highlight-top)]"
      >
        <Inbox className="size-4" />
      </span>
      <p className="mx-auto mt-3 max-w-[26ch] text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">{message}</p>
      {recoverable ? (
        <button
          type="button"
          onClick={onClear}
          className="mt-3 cursor-pointer rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-[11px] font-medium text-[color:var(--color-foreground)] transition-[border-color,transform] duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:border-[var(--color-border-strong)] active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
        >
          Show all conversations
        </button>
      ) : null}
    </div>
  );
}

/** The number inside a chip. Tabular so a rail of counts does not jitter as they change. */
function ChipCount({ children }: { children: number }) {
  return <span className="tabular rounded-full bg-current/10 px-1.5 text-[11px] font-semibold leading-[18px]">{children.toLocaleString("en-US")}</span>;
}

function FilterChip({
  active,
  tone,
  onClick,
  children,
}: {
  active: boolean;
  tone?: "warning";
  onClick: () => void;
  children: React.ReactNode;
}) {
  const base =
    "flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-[12px] font-medium transition-[background-color,border-color,color,transform] duration-[var(--duration-fast)] ease-[var(--ease-out)] active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]";
  const styles = active
    ? tone === "warning"
      ? "border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] text-[color:var(--color-warning-fg)] shadow-[var(--shadow-xs)]"
      : "border-[var(--color-primary)] bg-[var(--color-primary)] text-[var(--color-on-primary)] shadow-[var(--shadow-xs)]"
    : "border-[var(--color-border)] bg-[var(--color-surface)] text-[color:var(--color-muted-foreground)] hover:border-[var(--color-border-strong)] hover:text-[color:var(--color-foreground)]";

  return (
    <button type="button" onClick={onClick} aria-pressed={active} className={`${base} ${styles}`}>
      {children}
    </button>
  );
}

function ToolbarButton({
  onClick,
  pressed,
  disabled,
  children,
}: {
  onClick: () => void;
  pressed?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
      className={`flex shrink-0 cursor-pointer items-center gap-1.5 rounded-[var(--radius-xs)] px-1.5 py-1 font-medium transition-[background-color,color,transform] duration-[var(--duration-fast)] ease-[var(--ease-out)] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] ${
        pressed
          ? "bg-[var(--color-primary)] text-[var(--color-on-primary)]"
          : "text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)]"
      }`}
    >
      {children}
    </button>
  );
}

function BulkButton({
  disabled,
  onClick,
  children,
}: {
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex cursor-pointer items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[11px] font-medium text-[color:var(--color-foreground)] transition-[border-color,transform] duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:border-[var(--color-border-strong)] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
    >
      {children}
    </button>
  );
}

function SectionLabel({ icon, children }: { icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <p className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-[var(--color-border)] bg-[var(--color-surface-sunken)]/92 px-3.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-[color:var(--color-muted-foreground)] backdrop-blur-sm">
      {icon}
      {children}
    </p>
  );
}

function Row({
  conversation,
  href,
  category,
  active,
  cursored,
  compact,
  selecting,
  selected,
  onToggle,
}: {
  conversation: ConversationSummary;
  href: string;
  category: ChatCategorySummary | undefined;
  active: boolean;
  /** Highlighted by the keyboard, which is not the same as opened. */
  cursored: boolean;
  compact: boolean;
  selecting: boolean;
  selected: boolean;
  onToggle: () => void;
}) {
  const avatar = conversationAvatar(conversation.id, conversation.name);
  // Weight carries the unread state, not just a dot: an unanswered customer should be legible from
  // the far end of the list at a glance, the way an unread mail is.
  const unread = conversation.awaitingReply;

  const inner = (
    <>
      <span className="relative mt-0.5 shrink-0">
        {selecting ? (
          <span
            aria-hidden
            className={`flex ${compact ? "size-7" : "size-9"} items-center justify-center rounded-[var(--radius-lg)] border-2 transition-[background-color,border-color,transform] duration-[var(--duration-fast)] ease-[var(--ease-out)] ${
              selected
                ? "scale-[0.94] border-[var(--color-primary)] bg-[var(--color-primary)] text-[var(--color-on-primary)]"
                : "border-[var(--color-border-strong)] bg-[var(--color-surface)]"
            }`}
          >
            {selected ? <Check className="size-4" /> : null}
          </span>
        ) : (
          <span
            aria-hidden
            style={{ background: avatar.background, color: avatar.color }}
            className={`flex ${compact ? "size-7 text-[10px]" : "size-9 text-[12px]"} items-center justify-center rounded-[var(--radius-lg)] font-semibold tracking-[-0.01em] shadow-[var(--highlight-top)]`}
          >
            {avatar.initials}
          </span>
        )}
        {/* Two states, not one. A solid dot means nobody has looked. A hollow ring means somebody
            opened it and the customer STILL has no reply — without it "I glanced at it" and "it is
            handled" would look identical to the next person down the list. */}
        {conversation.awaitingReply && !selecting ? (
          <>
            <span
              aria-hidden
              title="A customer is waiting for a reply"
              className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-[var(--color-warning)] shadow-[0_0_0_2px_var(--color-surface-sunken)]"
            />
            <span className="sr-only">Waiting for a reply.</span>
          </>
        ) : conversation.isUnanswered && !selecting ? (
          <>
            <span
              aria-hidden
              title="Seen, but the customer still has no reply"
              className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-[1.5px] border-[var(--color-warning)] bg-[var(--color-surface)] shadow-[0_0_0_2px_var(--color-surface-sunken)]"
            />
            <span className="sr-only">Seen, still unanswered.</span>
          </>
        ) : null}
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5">
            {conversation.isPinned ? (
              <Pin className="size-3 shrink-0 text-[color:var(--color-muted-foreground)]" aria-label="Pinned" />
            ) : null}
            <span className={`truncate text-[13px] text-[color:var(--color-foreground)] ${unread ? "font-semibold" : "font-medium"}`}>
              {conversation.name}
            </span>
          </span>
          <span
            className={`tabular shrink-0 text-[11px] ${
              unread ? "font-medium text-[color:var(--color-warning-fg)]" : "text-[color:var(--color-muted-foreground)]"
            }`}
            // "10m" is relative to the clock reading it: the server and the browser can sit either
            // side of a minute boundary, which is not a mismatch worth re-rendering the list over.
            suppressHydrationWarning
          >
            {relativeTime(conversation.lastMessageAt)}
          </span>
        </span>

        <span className="mt-0.5 flex items-center gap-1.5">
          <span
            className={`min-w-0 flex-1 truncate text-[12px] ${
              unread ? "text-[color:var(--color-foreground)]" : "text-[color:var(--color-muted-foreground)]"
            }`}
          >
            {conversation.lastMessagePreview ? (
              <>
                {conversation.lastMessageOutgoing ? <span className="text-[color:var(--color-subtle-foreground)]">You: </span> : null}
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

        {/* Hidden in compact mode, which is the point of compact mode. */}
        {!compact ? (
          <span className="mt-1 flex flex-wrap items-center gap-1">
            {conversation.awaitingReply ? (
              <span className="rounded-[var(--radius-xs)] bg-[var(--color-warning-bg)] px-1.5 py-px text-[10px] font-medium text-[color:var(--color-warning-fg)]">
                Waiting
              </span>
            ) : null}
            {category ? (
              <span className="flex items-center gap-1 rounded-[var(--radius-xs)] bg-[var(--color-neutral-bg)] px-1.5 py-px text-[10px] text-[color:var(--color-neutral-fg)]">
                <span className={`size-1.5 rounded-full ${categoryDotClass(category.color)}`} aria-hidden />
                {category.name}
              </span>
            ) : null}
            {conversation.mood ? (
              <span
                title={`Detected mood: ${MOOD_LABELS[conversation.mood]} (Mood Detection — an inference)`}
                className={`rounded-[var(--radius-xs)] px-1.5 py-px text-[10px] font-medium ${
                  MOOD_LEVEL[conversation.mood] >= 3
                    ? "bg-[var(--color-danger-bg)] text-[color:var(--color-danger-fg)]"
                    : "bg-[var(--color-warning-bg)] text-[color:var(--color-warning-fg)]"
                }`}
              >
                <span aria-hidden>{MOOD_EMOJI[conversation.mood]}</span> {MOOD_LABELS[conversation.mood]}
              </span>
            ) : null}
            {conversation.aiAutomationEnabled ? (
              <span className="rounded-[var(--radius-xs)] bg-[var(--color-info-bg)] px-1.5 py-px text-[10px] font-medium text-[color:var(--color-info-fg)]">
                AI on
              </span>
            ) : null}
            {/* Quieter than the rest: on a roster where almost nothing is monitored this appears on
                almost every row, and a badge with a 99% hit rate should not shout. */}
            {!conversation.isMonitored ? <span className="text-[10px] text-[color:var(--color-subtle-foreground)]">Not monitored</span> : null}
          </span>
        ) : null}
      </span>
    </>
  );

  const shell = [
    "group/row relative flex w-full gap-3 border-b border-[var(--color-border)] text-left",
    compact ? "px-3.5 py-2" : "px-3.5 py-3",
    "transition-[background-color,transform] duration-[var(--duration-fast)] ease-[var(--ease-out)]",
    "active:translate-y-px",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-focus-ring)]",
    cursored ? "ring-2 ring-inset ring-[var(--color-focus-ring)]" : "",
    selected ? "bg-[var(--color-primary)]/[0.07]" : active ? "bg-[var(--color-surface)]" : "hover:bg-[var(--color-neutral-bg)]/60",
  ].join(" ");

  // In selection mode the row is a button, not a link: a real href under the cursor would let
  // middle-click and ctrl-click navigate away mid-selection and lose it.
  return (
    <li className="relative">
      {active ? <span aria-hidden className="absolute inset-y-0 left-0 z-[1] w-[3px] bg-[var(--color-primary)]" /> : null}
      {selecting ? (
        <button type="button" onClick={onToggle} aria-pressed={selected} className={`${shell} cursor-pointer`}>
          {inner}
        </button>
      ) : (
        <Link href={href} aria-current={active ? "page" : undefined} className={shell}>
          {inner}
        </Link>
      )}
    </li>
  );
}
