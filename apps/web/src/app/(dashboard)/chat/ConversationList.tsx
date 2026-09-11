"use client";

import {
  Archive,
  BellRing,
  Check,
  CheckSquare,
  EyeOff,
  Inbox,
  MailOpen,
  Pin,
  PinOff,
  Rows3,
  Rows4,
  Search,
  Settings2,
  Tag,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { useToast } from "@/components/ui";
import {
  setChatArchived,
  setChatCategory,
  setChatPinned,
  setChatReviewed,
} from "@/server/actions/chatOrganisation";
import {
  CONVERSATION_LIST_LIMIT,
  type ChatCategorySummary,
  type ConversationSummary,
} from "@/server/chatInbox";
import { CategoryManager } from "./CategoryManager";
import { conversationAvatar } from "./avatar";
import { categoryDotClass } from "./categoryColors";

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

/** "All", "awaiting a reply", a category id, or the archive. */
type Filter =
  | { kind: "all" }
  | { kind: "waiting" }
  /** Opened by somebody, and the customer still has no reply. */
  | { kind: "seen-unanswered" }
  | { kind: "category"; id: string }
  | { kind: "archived" };

function isSameFilter(a: Filter, b: Filter): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === "category" && b.kind === "category" ? a.id === b.id : true;
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
 * The left pane, rendered once by the chat layout so it keeps its scroll position as you move
 * between conversations.
 *
 * Filtering is local rather than a server round-trip: the layout already loaded the list (name and
 * last line only), so matching in the browser is instant. That also means local search cannot
 * reach past CONVERSATION_LIST_LIMIT, so the cap is surfaced rather than left invisible.
 *
 * Selection mode is deliberately a mode rather than always-on checkboxes. This list is read far
 * more often than it is reorganised, and a checkbox against every row turns a reading surface into
 * a form — the same reason WhatsApp hides its own until you long-press. Clicking a row means "open
 * this conversation" until you say otherwise.
 *
 * The filter rail scrolls sideways rather than wrapping. Wrapping looked harmless with two
 * categories and pushed the first conversation below the fold once a team had six: the header grew
 * downward without limit while the list it was filtering shrank. A rail has a fixed height whatever
 * the team files their work into.
 */
export function ConversationList({
  conversations,
  categories,
}: {
  conversations: ConversationSummary[];
  categories: ChatCategorySummary[];
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>({ kind: "all" });
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [managingCategories, setManagingCategories] = useState(false);
  const compact = useSyncExternalStore(subscribeDensity, densitySnapshot, densityServerSnapshot);
  const [cursor, setCursor] = useState(-1);
  const [pending, startTransition] = useTransition();
  const { showToast } = useToast();
  const searchRef = useRef<HTMLInputElement>(null);

  const activeGroupId = pathname.startsWith("/chat/") ? pathname.slice("/chat/".length) : undefined;

  const toggleDensity = useCallback(() => writeDensity(!densitySnapshot()), []);

  const seenUnansweredCount = useMemo(
    () => conversations.filter((c) => c.isUnanswered && !c.awaitingReply).length,
    [conversations],
  );

  const waitingCount = useMemo(
    () => conversations.filter((conversation) => conversation.awaitingReply).length,
    [conversations],
  );
  const pinnedCount = useMemo(
    () => conversations.filter((conversation) => conversation.isPinned).length,
    [conversations],
  );
  const categoryById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);

  const capped = conversations.length >= CONVERSATION_LIST_LIMIT;

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return conversations.filter((conversation) => {
      if (filter.kind === "waiting" && !conversation.awaitingReply) return false;
      if (filter.kind === "seen-unanswered" && !(conversation.isUnanswered && !conversation.awaitingReply)) {
        return false;
      }
      if (filter.kind === "category" && conversation.categoryId !== filter.id) return false;
      // Archived rows never reach this component — the server excludes them — so the archive
      // filter is a link to its own view rather than a predicate here.
      if (!needle) return true;
      const haystack = `${conversation.name} ${conversation.accountLabel} ${conversation.lastMessagePreview ?? ""}`;
      return haystack.toLowerCase().includes(needle);
    });
  }, [conversations, query, filter]);

  // Pinned rows are split into their own section only in the unfiltered view. Inside a category
  // the useful ordering is recency — repeating the pinned block there would show the same three
  // groups twice on one screen.
  //
  // Computed in ONE memo rather than three statements: `navigable` is what the keyboard walks, and
  // deriving it from two separately-recreated arrays would rebuild it on every render, defeating
  // the memo and re-running the cursor clamp for nothing.
  const { pinnedRows, otherRows, navigable } = useMemo(() => {
    const split = filter.kind === "all" && !query.trim() && pinnedCount > 0;
    const pinned = split ? filtered.filter((c) => c.isPinned) : [];
    const rest = split ? filtered.filter((c) => !c.isPinned) : filtered;
    // The keyboard walks what is on screen, in the order it is on screen.
    return { pinnedRows: pinned, otherRows: rest, navigable: [...pinned, ...rest] };
  }, [filtered, filter, query, pinnedCount]);

  // Clamped at read time rather than reset in an effect: typing shrinks the list under a cursor
  // that was valid a keystroke ago, and setting state from an effect to correct that costs a
  // second render pass on every character.
  const activeCursor = cursor < 0 ? -1 : Math.min(cursor, navigable.length - 1);

  const selectedIds = [...selected];
  const allSelectedPinned = selectedIds.length > 0 && selectedIds.every((id) => conversations.find((c) => c.id === id)?.isPinned);

  // "/" to search, from anywhere on the page. The shortcut every inbox has, and the reason the
  // hint is printed in the field rather than left to be discovered.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      // Never steal the key from someone typing a message.
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  function onSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((current) => Math.min(current + 1, navigable.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter" && navigable[activeCursor]) {
      event.preventDefault();
      router.push(`/chat/${navigable[activeCursor]!.id}`);
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
  function runBulk(label: string, action: () => Promise<{ error?: string; updated?: number; unchanged?: number }>) {
    startTransition(async () => {
      const result = await action();
      if (result.error) {
        showToast({ tone: "danger", title: result.error });
        return;
      }
      const updated = result.updated ?? 0;
      showToast({
        tone: "success",
        title: `${updated} conversation${updated === 1 ? "" : "s"} ${label}`,
        // "8 moved, 3 already there" rather than "Done" — an operator who selected eleven and saw
        // eight move needs to know the other three were not a failure.
        description: result.unchanged ? `${result.unchanged} already ${label}.` : undefined,
      });
      exitSelection();
    });
  }

  // `key` is deliberately NOT part of this object. React 19 does not read a spread key, and the
  // lint rule that catches it is right to: a list whose keys silently became undefined would
  // re-create every row on every keystroke.
  const rowProps = (conversation: ConversationSummary, index: number) => ({
    conversation,
    category: conversation.categoryId ? categoryById.get(conversation.categoryId) : undefined,
    active: conversation.id === activeGroupId,
    cursored: index === activeCursor,
    compact,
    selecting,
    selected: selected.has(conversation.id),
    onToggle: () => toggleSelected(conversation.id),
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-3 pb-2 pt-3">
        <div className="flex items-center gap-1.5">
          <div className="relative min-w-0 flex-1">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[color:var(--color-muted-foreground)]"
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
              placeholder="Search conversations"
              aria-label="Search conversations"
              aria-keyshortcuts="/"
              className="h-9 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] pl-8 pr-14 text-[13px] text-[color:var(--color-foreground)] outline-none transition-[border-color,box-shadow] duration-[var(--duration-fast)] placeholder:text-[color:var(--color-muted-foreground)] focus-visible:border-[var(--color-primary)] focus-visible:ring-[3px] focus-visible:ring-[var(--color-primary)]/12"
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
                className="absolute right-2 top-1/2 flex size-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded-[var(--radius-xs)] text-[color:var(--color-muted-foreground)] transition-colors duration-[var(--duration-fast)] hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)]"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            ) : (
              // The shortcut, shown rather than hidden. A keyboard affordance nobody knows about
              // is the same as no keyboard affordance.
              <kbd
                aria-hidden
                className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded-[var(--radius-xs)] border border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-1.5 py-0.5 text-[10px] font-medium text-[color:var(--color-subtle-foreground)]"
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
            className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] text-[color:var(--color-muted-foreground)] transition-[border-color,color,transform] duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:border-[var(--color-border-strong)] hover:text-[color:var(--color-foreground)] active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
          >
            {compact ? <Rows3 className="size-4" aria-hidden /> : <Rows4 className="size-4" aria-hidden />}
          </button>
        </div>

        {/* One rail, scrolled sideways, never wrapped. Order is the order they are reached for:
            everything, then the two numbers a support inbox is opened to answer, then the team's
            own folders. */}
        <div
          className="-mx-1 mt-2 flex items-center gap-1.5 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          role="group"
          aria-label="Filter conversations"
        >
          <FilterChip active={isSameFilter(filter, { kind: "all" })} onClick={() => setFilter({ kind: "all" })}>
            All
            <ChipCount>{conversations.length}</ChipCount>
          </FilterChip>

          {waitingCount > 0 ? (
            <FilterChip
              tone="warning"
              active={isSameFilter(filter, { kind: "waiting" })}
              onClick={() => setFilter({ kind: "waiting" })}
            >
              <Inbox className="size-3" aria-hidden />
              Waiting
              <ChipCount>{waitingCount}</ChipCount>
            </FilterChip>
          ) : null}

          {/* Separate from "waiting" on purpose: these are conversations somebody has already
              opened and the customer still has no answer. They are gone from the waiting count by
              design — this is where they went, so they cannot quietly disappear. */}
          {seenUnansweredCount > 0 ? (
            <FilterChip
              active={isSameFilter(filter, { kind: "seen-unanswered" })}
              onClick={() => setFilter({ kind: "seen-unanswered" })}
            >
              <EyeOff className="size-3" aria-hidden />
              Seen, unanswered
              <ChipCount>{seenUnansweredCount}</ChipCount>
            </FilterChip>
          ) : null}

          {categories.map((category) => (
            <FilterChip
              key={category.id}
              active={isSameFilter(filter, { kind: "category", id: category.id })}
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
            aria-label="Manage categories"
            className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full border border-dashed border-[var(--color-border-strong)] text-[color:var(--color-muted-foreground)] transition-[border-color,color,transform] duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:border-[var(--color-primary)] hover:text-[color:var(--color-foreground)] active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
          >
            <Settings2 className="size-3" aria-hidden />
          </button>
        </div>

        <div className="mt-1.5 flex items-center gap-2 text-[11px]">
          <ToolbarButton onClick={() => (selecting ? exitSelection() : setSelecting(true))} pressed={selecting}>
            <CheckSquare className="size-3.5" aria-hidden />
            {selecting ? "Cancel" : "Select"}
          </ToolbarButton>

          {selecting && filtered.length > 0 ? (
            <ToolbarButton
              onClick={() =>
                setSelected((current) =>
                  current.size === filtered.length ? new Set() : new Set(filtered.map((c) => c.id)),
                )
              }
            >
              {selected.size === filtered.length ? "Clear all" : `Select all ${filtered.length}`}
            </ToolbarButton>
          ) : null}

          {/* Scoped to the waiting filter on purpose. "Mark everything read" from the All tab
              would be a single click that silences the entire inbox, and the one place that
              gesture is genuinely wanted is the list of things you have just read. */}
          {!selecting && filter.kind === "waiting" && filtered.length > 0 ? (
            <ToolbarButton
              disabled={pending}
              onClick={() => {
                runBulk("marked as read", () => setChatReviewed(filtered.map((c) => c.id), true));
                // Back to All afterwards: the waiting chip only renders while something is
                // waiting, so staying here would leave the reader on a filter whose own control
                // has just disappeared, looking at an empty list.
                setFilter({ kind: "all" });
              }}
            >
              <MailOpen className="size-3.5" aria-hidden />
              Mark all {filtered.length} read
            </ToolbarButton>
          ) : null}

          <Link
            href="/chat/archived"
            className="ml-auto flex shrink-0 items-center gap-1 rounded-[var(--radius-xs)] px-1.5 py-1 text-[color:var(--color-muted-foreground)] transition-colors duration-[var(--duration-fast)] hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
          >
            <Archive className="size-3" aria-hidden />
            Archived
          </Link>
        </div>
      </div>

      {/* The bulk bar replaces nothing and covers nothing — it appears between the filters and the
          list, so the rows it acts on stay visible while you choose what to do to them. */}
      {selecting && selected.size > 0 ? (
        <div className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-neutral-bg)] px-3 py-2">
          <p className="mb-1.5 text-[11px] font-medium text-[color:var(--color-foreground)]" aria-live="polite">
            {selected.size} selected
          </p>
          <div className="flex flex-wrap gap-1.5">
            <BulkButton
              disabled={pending}
              onClick={() =>
                runBulk(allSelectedPinned ? "unpinned" : "pinned", () =>
                  setChatPinned(selectedIds, !allSelectedPinned),
                )
              }
            >
              {allSelectedPinned ? <PinOff className="size-3" aria-hidden /> : <Pin className="size-3" aria-hidden />}
              {allSelectedPinned ? "Unpin" : "Pin"}
            </BulkButton>

            {categories.map((category) => (
              <BulkButton
                key={category.id}
                disabled={pending}
                onClick={() => runBulk(`moved to ${category.name}`, () => setChatCategory(selectedIds, category.id))}
              >
                <span className={`size-2 shrink-0 rounded-full ${categoryDotClass(category.color)}`} aria-hidden />
                {category.name}
              </BulkButton>
            ))}

            <BulkButton disabled={pending} onClick={() => runBulk("uncategorised", () => setChatCategory(selectedIds, null))}>
              <Tag className="size-3" aria-hidden />
              Remove category
            </BulkButton>

            {/* Clearing "waiting" in bulk is the point of selection mode for most people: you have
                already dealt with these on your phone and telling the inbox so one conversation at
                a time is worse than useless. Safe in bulk because the mark is a timestamp — every
                one of these returns the moment its customer writes again. */}
            <BulkButton disabled={pending} onClick={() => runBulk("marked as read", () => setChatReviewed(selectedIds, true))}>
              <MailOpen className="size-3" aria-hidden />
              Mark as read
            </BulkButton>

            <BulkButton disabled={pending} onClick={() => runBulk("marked as waiting", () => setChatReviewed(selectedIds, false))}>
              <BellRing className="size-3" aria-hidden />
              Mark as waiting
            </BulkButton>

            <BulkButton disabled={pending} onClick={() => runBulk("archived", () => setChatArchived(selectedIds, true))}>
              <Archive className="size-3" aria-hidden />
              Archive
            </BulkButton>
          </div>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {filtered.length === 0 ? (
          <EmptyList
            conversations={conversations.length}
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

            {capped ? (
              // Moved to the foot of the list and cut to one line. Three lines of caveat above the
              // first conversation is a caption on a tool somebody opens fifty times a day; at the
              // bottom it is exactly where the question "is that everything?" gets asked.
              <p className="border-t border-[var(--color-border)] px-3.5 py-3 text-[11px] leading-relaxed text-[color:var(--color-subtle-foreground)]">
                Showing the {CONVERSATION_LIST_LIMIT} most recently active groups, and search covers
                only these. Archive what you do not need here.
              </p>
            ) : null}
          </>
        )}
      </div>

      <CategoryManager
        open={managingCategories}
        onClose={() => setManagingCategories(false)}
        categories={categories}
      />
    </div>
  );
}

function EmptyList({
  conversations,
  filter,
  query,
  onClear,
}: {
  conversations: number;
  filter: Filter;
  query: string;
  onClear: () => void;
}) {
  const message =
    conversations === 0
      ? "No groups yet. Connect an account and run a group sync to populate this list."
      : filter.kind === "seen-unanswered"
        ? "Nothing has been seen and left unanswered."
        : filter.kind === "waiting"
          ? "Nothing is waiting on a reply."
          : filter.kind === "category"
            ? "Nothing filed here yet. Use Select to move conversations into it."
            : `No group matches “${query}”.`;

  // An empty state that only states the obvious leaves the reader to work out the way back. When
  // the emptiness is something they caused, the way back is one button.
  const recoverable = conversations > 0 && (query.trim().length > 0 || filter.kind !== "all");

  return (
    <div className="px-6 py-12 text-center">
      <span
        aria-hidden
        className="mx-auto flex size-9 items-center justify-center rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] text-[color:var(--color-subtle-foreground)] shadow-[var(--shadow-xs),var(--highlight-top)]"
      >
        <Inbox className="size-4" />
      </span>
      <p className="mx-auto mt-3 max-w-[22ch] text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
        {message}
      </p>
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
function ChipCount({ children }: { children: React.ReactNode }) {
  return <span className="tabular text-[10px] opacity-55">{children}</span>;
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
    "flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-[background-color,border-color,color,transform] duration-[var(--duration-fast)] ease-[var(--ease-out)] active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]";
  const styles = active
    ? tone === "warning"
      ? "border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] text-[color:var(--color-warning-fg)]"
      : "border-[var(--color-primary)] bg-[var(--color-primary)] text-[var(--color-on-primary)]"
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
      className="flex cursor-pointer items-center gap-1.5 rounded-[var(--radius-xs)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[11px] font-medium text-[color:var(--color-foreground)] transition-[border-color,transform] duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:border-[var(--color-border-strong)] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
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
  category,
  active,
  cursored,
  compact,
  selecting,
  selected,
  onToggle,
}: {
  conversation: ConversationSummary;
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
  // Weight carries the unread state, not just a 10px dot. An unanswered customer should be legible
  // from the far end of the list at a glance, the same way an unread mail is.
  const unread = conversation.awaitingReply;

  const inner = (
    <>
      <span className="relative mt-0.5 shrink-0">
        {selecting ? (
          <span
            aria-hidden
            className={`flex ${compact ? "size-7" : "size-9"} items-center justify-center rounded-[var(--radius-lg)] border text-[12px] font-semibold transition-[background-color,border-color,transform] duration-[var(--duration-fast)] ease-[var(--ease-out)] ${
              selected
                ? "scale-[0.94] border-[var(--color-primary)] bg-[var(--color-primary)] text-[var(--color-on-primary)]"
                : "border-[var(--color-border)] bg-[var(--color-surface-sunken)] text-[color:var(--color-muted-foreground)]"
            }`}
          >
            {selected ? <Check className="size-4" /> : avatar.initials}
          </span>
        ) : (
          // Tinted per group and stable forever — see avatar.ts. The inner highlight is the same
          // one every raised surface in this app carries, so the monogram sits on the shared
          // light source rather than looking pasted on.
          <span
            aria-hidden
            style={{ background: avatar.background, color: avatar.color }}
            className={`flex ${compact ? "size-7 text-[10px]" : "size-9 text-[12px]"} items-center justify-center rounded-[var(--radius-lg)] font-semibold tracking-[-0.01em] shadow-[var(--highlight-top)]`}
          >
            {avatar.initials}
          </span>
        )}
        {/* Two states, not one, and the second is the important one. A solid dot means nobody
            has even looked. A hollow ring means somebody opened it and the customer STILL has no
            reply — which is the case this whole feature could otherwise hide, since opening a
            conversation is what clears it from the waiting list. Without the ring, "I glanced at
            it" and "it is handled" would look identical to the next person down the list. */}
        {conversation.awaitingReply && !selecting ? (
          <>
            <span
              aria-hidden
              title="A customer is waiting for a reply"
              className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-[var(--color-warning)] shadow-[0_0_0_2px_var(--color-surface-sunken)]"
            />
            {/* The dot is shape and colour. A screen reader gets the same fact in words, because
                "title" on a decorative span is not reliably announced. */}
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
            <span
              className={`truncate text-[13px] text-[color:var(--color-foreground)] ${
                unread ? "font-semibold" : "font-medium"
              }`}
            >
              {conversation.name}
            </span>
          </span>
          <span
            className={`tabular shrink-0 text-[10px] ${
              unread ? "font-medium text-[color:var(--color-warning-fg)]" : "text-[color:var(--color-muted-foreground)]"
            }`}
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

        {/* Hidden in compact mode, which is the point of compact mode. The state is still one
            click away in the conversation header, and a badge that appears on every row carries
            no information while costing a line on all of them. */}
        {!compact ? (
          <span className="mt-1 flex flex-wrap items-center gap-1">
            {category ? (
              <span className="flex items-center gap-1 rounded-[var(--radius-xs)] bg-[var(--color-neutral-bg)] px-1.5 py-px text-[10px] text-[color:var(--color-neutral-fg)]">
                <span className={`size-1.5 rounded-full ${categoryDotClass(category.color)}`} aria-hidden />
                {category.name}
              </span>
            ) : null}
            {conversation.aiAutomationEnabled ? (
              <span className="rounded-[var(--radius-xs)] bg-[var(--color-info-bg)] px-1.5 py-px text-[10px] font-medium text-[color:var(--color-info-fg)]">
                AI on
              </span>
            ) : null}
            {/* Quieter than the rest: on a roster where almost nothing is monitored this appears on
                almost every row, and a badge with a 99% hit rate should not shout. */}
            {!conversation.isMonitored ? (
              <span className="text-[10px] text-[color:var(--color-subtle-foreground)]">Not monitored</span>
            ) : null}
          </span>
        ) : null}
      </span>
    </>
  );

  // A press state and a focus ring, neither of which this row had. The press is a 1px settle
  // rather than a scale: a scaling row nudges every row below it, and in a list you are dragging
  // your eye down that reads as the list moving under you.
  const shell = [
    "group/row relative flex w-full gap-3 border-b border-[var(--color-border)] text-left",
    compact ? "px-3.5 py-2" : "px-3.5 py-3",
    "transition-[background-color,transform] duration-[var(--duration-fast)] ease-[var(--ease-out)]",
    "active:translate-y-px",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-focus-ring)]",
    cursored ? "ring-2 ring-inset ring-[var(--color-focus-ring)]" : "",
    active ? "bg-[var(--color-neutral-bg)]" : "hover:bg-[var(--color-neutral-bg)]/60",
  ].join(" ");

  // In selection mode the row is a button, not a link. Keeping it a link and intercepting the
  // click would leave a real href under the cursor — middle-click, ctrl-click and "open in new
  // tab" would all navigate away mid-selection and lose it.
  return (
    <li className="relative">
      {/* An edge marker for the open conversation. The background fill alone is the same weight as
          the hover state, so on a list you are running the cursor down, "which one is open" and
          "which one am I over" become the same colour. */}
      {active ? (
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 w-0.5 bg-[var(--color-primary)]"
        />
      ) : null}
      {selecting ? (
        <button type="button" onClick={onToggle} aria-pressed={selected} className={`${shell} cursor-pointer`}>
          {inner}
        </button>
      ) : (
        <Link href={`/chat/${conversation.id}`} aria-current={active ? "page" : undefined} className={shell}>
          {inner}
        </Link>
      )}
    </li>
  );
}
