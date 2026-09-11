"use client";

import { Archive, BellRing, Check, CheckSquare, EyeOff, Inbox, MailOpen, Pin, PinOff, Search, Settings2, Tag, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
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
 */
export function ConversationList({
  conversations,
  categories,
}: {
  conversations: ConversationSummary[];
  categories: ChatCategorySummary[];
}) {
  const pathname = usePathname();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>({ kind: "all" });
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [managingCategories, setManagingCategories] = useState(false);
  const [pending, startTransition] = useTransition();
  const { showToast } = useToast();

  const activeGroupId = pathname.startsWith("/chat/") ? pathname.slice("/chat/".length) : undefined;

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
  const showPinnedSection = filter.kind === "all" && !query.trim() && pinnedCount > 0;
  const pinnedRows = showPinnedSection ? filtered.filter((c) => c.isPinned) : [];
  const otherRows = showPinnedSection ? filtered.filter((c) => !c.isPinned) : filtered;

  const selectedIds = [...selected];
  const allSelectedPinned = selectedIds.length > 0 && selectedIds.every((id) => conversations.find((c) => c.id === id)?.isPinned);

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

        {/* Filter chips, in the order they are reached for: everything, then the one number that
            matters in a support inbox, then the team's own folders. */}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <FilterChip active={isSameFilter(filter, { kind: "all" })} onClick={() => setFilter({ kind: "all" })}>
            All
          </FilterChip>
          {waitingCount > 0 ? (
            <FilterChip
              tone="warning"
              active={isSameFilter(filter, { kind: "waiting" })}
              onClick={() => setFilter({ kind: "waiting" })}
            >
              <Inbox className="size-3" aria-hidden />
              {waitingCount} waiting
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
              {seenUnansweredCount} seen, unanswered
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
              <span className="tabular opacity-60">{category.count}</span>
            </FilterChip>
          ))}

          <button
            type="button"
            onClick={() => setManagingCategories(true)}
            title="Manage categories"
            aria-label="Manage categories"
            className="flex size-6 cursor-pointer items-center justify-center rounded-full border border-dashed border-[var(--color-border-strong)] text-[color:var(--color-muted-foreground)] transition-colors duration-[var(--duration-fast)] hover:border-[var(--color-primary)] hover:text-[color:var(--color-foreground)]"
          >
            <Settings2 className="size-3" aria-hidden />
          </button>
        </div>

        <div className="mt-2 flex items-center gap-2 text-[11px]">
          <button
            type="button"
            onClick={() => (selecting ? exitSelection() : setSelecting(true))}
            aria-pressed={selecting}
            className={`flex cursor-pointer items-center gap-1.5 rounded-[var(--radius-xs)] px-1.5 py-1 font-medium transition-colors duration-[var(--duration-fast)] ${
              selecting
                ? "bg-[var(--color-primary)]/10 text-[color:var(--color-primary)]"
                : "text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
            }`}
          >
            <CheckSquare className="size-3.5" aria-hidden />
            {selecting ? "Cancel selection" : "Select"}
          </button>

          {selecting && filtered.length > 0 ? (
            <button
              type="button"
              onClick={() =>
                setSelected((current) =>
                  current.size === filtered.length ? new Set() : new Set(filtered.map((c) => c.id)),
                )
              }
              className="cursor-pointer text-[color:var(--color-muted-foreground)] underline-offset-2 hover:underline"
            >
              {selected.size === filtered.length ? "Clear all" : `Select all ${filtered.length}`}
            </button>
          ) : null}

          {/* Scoped to the waiting filter on purpose. "Mark everything read" from the All tab
              would be a single click that silences the entire inbox, and the one place that
              gesture is genuinely wanted is the list of things you have just read. */}
          {!selecting && filter.kind === "waiting" && filtered.length > 0 ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                runBulk("marked as read", () => setChatReviewed(filtered.map((c) => c.id), true));
                // Back to All afterwards: the waiting chip only renders while something is
                // waiting, so staying here would leave the reader on a filter whose own control
                // has just disappeared, looking at an empty list.
                setFilter({ kind: "all" });
              }}
              className="flex cursor-pointer items-center gap-1 text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)] disabled:opacity-50"
            >
              <MailOpen className="size-3.5" aria-hidden />
              Mark all {filtered.length} read
            </button>
          ) : null}

          <Link
            href="/chat/archived"
            className="ml-auto flex items-center gap-1 text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
          >
            <Archive className="size-3" aria-hidden />
            Archived
          </Link>
        </div>

        {capped ? (
          <p className="mt-2 text-[11px] leading-relaxed text-[color:var(--color-muted-foreground)]">
            Showing the {CONVERSATION_LIST_LIMIT} most recently active groups. Search filters only these —
            archive the ones you do not need here, or stop monitoring them on the Groups page.
          </p>
        ) : null}
      </div>

      {/* The bulk bar replaces nothing and covers nothing — it appears between the filters and the
          list, so the rows it acts on stay visible while you choose what to do to them. */}
      {selecting && selected.size > 0 ? (
        <div className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-neutral-bg)] px-3 py-2">
          <p className="mb-1.5 text-[11px] font-medium text-[color:var(--color-foreground)]">
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

      <div className="min-h-0 flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <p className="px-4 py-10 text-center text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
            {conversations.length === 0
              ? "No groups yet. Connect an account and run a group sync to populate this list."
              : filter.kind === "seen-unanswered"
                ? "Nothing has been seen and left unanswered."
                : filter.kind === "waiting"
                  ? "Nothing is waiting on a reply."
                : filter.kind === "category"
                  ? "Nothing filed here yet. Use Select to move conversations into it."
                  : `No group matches “${query}”.`}
          </p>
        ) : (
          <>
            {pinnedRows.length > 0 ? (
              <>
                <SectionLabel icon={<Pin className="size-3" aria-hidden />}>Pinned</SectionLabel>
                <ul>
                  {pinnedRows.map((conversation) => (
                    <Row
                      key={conversation.id}
                      conversation={conversation}
                      category={conversation.categoryId ? categoryById.get(conversation.categoryId) : undefined}
                      active={conversation.id === activeGroupId}
                      selecting={selecting}
                      selected={selected.has(conversation.id)}
                      onToggle={() => toggleSelected(conversation.id)}
                    />
                  ))}
                </ul>
                <SectionLabel>All conversations</SectionLabel>
              </>
            ) : null}

            <ul>
              {otherRows.map((conversation) => (
                <Row
                  key={conversation.id}
                  conversation={conversation}
                  category={conversation.categoryId ? categoryById.get(conversation.categoryId) : undefined}
                  active={conversation.id === activeGroupId}
                  selecting={selecting}
                  selected={selected.has(conversation.id)}
                  onToggle={() => toggleSelected(conversation.id)}
                />
              ))}
            </ul>
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
    "flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors duration-[var(--duration-fast)]";
  const styles = active
    ? tone === "warning"
      ? "border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] text-[color:var(--color-warning-fg)]"
      : "border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[color:var(--color-primary)]"
    : "border-[var(--color-border)] bg-[var(--color-surface)] text-[color:var(--color-muted-foreground)] hover:border-[var(--color-border-strong)] hover:text-[color:var(--color-foreground)]";

  return (
    <button type="button" onClick={onClick} aria-pressed={active} className={`${base} ${styles}`}>
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
      className="flex cursor-pointer items-center gap-1.5 rounded-[var(--radius-xs)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[11px] font-medium text-[color:var(--color-foreground)] transition-colors duration-[var(--duration-fast)] hover:border-[var(--color-border-strong)] disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function SectionLabel({ icon, children }: { icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-1.5 bg-[var(--color-surface-sunken)] px-3.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-[color:var(--color-muted-foreground)]">
      {icon}
      {children}
    </p>
  );
}

function Row({
  conversation,
  category,
  active,
  selecting,
  selected,
  onToggle,
}: {
  conversation: ConversationSummary;
  category: ChatCategorySummary | undefined;
  active: boolean;
  selecting: boolean;
  selected: boolean;
  onToggle: () => void;
}) {
  const avatar = conversationAvatar(conversation.id, conversation.name);

  const inner = (
    <>
      <span className="relative mt-0.5 shrink-0">
        {selecting ? (
          <span
            aria-hidden
            className={`flex size-9 items-center justify-center rounded-[var(--radius-lg)] border text-[12px] font-semibold transition-[background-color,border-color,transform] duration-[var(--duration-fast)] ${
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
            className="flex size-9 items-center justify-center rounded-[var(--radius-lg)] text-[12px] font-semibold tracking-[-0.01em] shadow-[var(--highlight-top)]"
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
          <span
            title="A customer is waiting for a reply"
            className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-[var(--color-warning)] shadow-[0_0_0_2px_var(--color-surface-sunken)]"
          />
        ) : conversation.isUnanswered && !selecting ? (
          <span
            title="Seen, but the customer still has no reply"
            className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-[1.5px] border-[var(--color-warning)] bg-[var(--color-surface)] shadow-[0_0_0_2px_var(--color-surface-sunken)]"
          />
        ) : null}
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5">
            {conversation.isPinned ? (
              <Pin className="size-3 shrink-0 text-[color:var(--color-muted-foreground)]" aria-label="Pinned" />
            ) : null}
            <span className="truncate text-[13px] font-medium text-[color:var(--color-foreground)]">
              {conversation.name}
            </span>
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
          {category ? (
            <span className="flex items-center gap-1 rounded-[var(--radius-xs)] bg-[var(--color-neutral-bg)] px-1.5 py-px text-[10px] text-[color:var(--color-neutral-fg)]">
              <span className={`size-1.5 rounded-full ${categoryDotClass(category.color)}`} aria-hidden />
              {category.name}
            </span>
          ) : null}
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
    </>
  );

  // A press state and a focus ring, neither of which this row had. The press is a 1px settle
  // rather than a scale: a scaling row nudges every row below it, and in a list you are dragging
  // your eye down that reads as the list moving under you.
  const shell = [
    "group/row relative flex w-full gap-3 border-b border-[var(--color-border)] px-3.5 py-3 text-left",
    "transition-[background-color,transform] duration-[var(--duration-fast)] ease-[var(--ease-out)]",
    "active:translate-y-px",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-focus-ring)]",
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
