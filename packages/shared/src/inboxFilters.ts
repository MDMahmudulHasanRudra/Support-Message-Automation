/**
 * The unified inbox's filter set (INBOX_WORKSPACE.md § Inbox): one validated shape shared by the list,
 * saved views and bulk selection, so a saved view can only ever hold what the list itself accepts.
 * A filter only NARROWS what the viewer can already read — it is never an access rule.
 */

export const INBOX_VIEW_KEYS = ["all", "mine", "unassigned", "unread", "needs-reply", "high", "urgent", "closed", "ai"] as const;
export type InboxViewKey = (typeof INBOX_VIEW_KEYS)[number];

/** List order. Null = newest activity first (the default). "waiting" = conversations awaiting a reply first, longest wait first. */
export const INBOX_SORT_KEYS = ["newest", "oldest", "waiting"] as const;
export type InboxSortKey = (typeof INBOX_SORT_KEYS)[number];

/** Who sent the newest message: the customer (the ball is in our court) or us (a person, the business number, AI). */
export const INBOX_LAST_SENDER_KEYS = ["customer", "team"] as const;
export type InboxLastSenderKey = (typeof INBOX_LAST_SENDER_KEYS)[number];

/**
 * "upset": a customer's newest mood reading in the last day was frustrated or worse (Mood Detection, WhatsApp groups only).
 * A later calm message writes no reading, so a reading stands until it is a day old.
 */
export const INBOX_MOOD_KEYS = ["upset"] as const;
export type InboxMoodKey = (typeof INBOX_MOOD_KEYS)[number];
/** How far back the "upset" filter and the "AI is handling" view look. */
export const INBOX_RECENT_HOURS = 24;

export const INBOX_WITHIN_KEYS = ["24h", "7d", "30d"] as const;
export type InboxWithinKey = (typeof INBOX_WITHIN_KEYS)[number];

export interface InboxFilterSet {
  view: InboxViewKey;
  within: InboxWithinKey | null;
  search: string;
  /** Normalised tag (see normaliseConversationTags). */
  tag: string | null;
  teamId: string | null;
  /** A dashboard user id. */
  assigneeId: string | null;
  /** `wa:<WhatsAppAccount id>` or `ch:<ChannelConnection id>`. */
  account: string | null;
  /**
   * Inbox V3 (UNIFIED_INBOX_V3): only conversations in this status. Null = the active ones (Open and Pending);
   * ignored while the feature is off.
   */
  status: "OPEN" | "PENDING" | "SNOOZED" | "RESOLVED" | null;
  /** Inbox V3 triage: list order; null = newest first. Ignored while the feature is off. */
  sort: Exclude<InboxSortKey, "newest"> | null;
  /** Inbox V3 triage: who spoke last; null = anyone. Ignored while the feature is off. */
  lastSender: InboxLastSenderKey | null;
  /** Only conversations with an upset customer; null = anyone. Narrows to WhatsApp groups, the only place mood is read. */
  mood: InboxMoodKey | null;
}

const LIFECYCLE_FILTERS = ["OPEN", "PENDING", "SNOOZED", "RESOLVED"] as const;

export const EMPTY_INBOX_FILTERS: InboxFilterSet = { view: "all", within: null, search: "", tag: null, teamId: null, assigneeId: null, account: null, status: null, sort: null, lastSender: null, mood: null };

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const ACCOUNT = /^(wa|ch):[A-Za-z0-9_-]{1,64}$/;
const TAG = /^[\p{L}\p{M}\p{N}_-]{1,32}$/u;

function pick<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

/** Anything from a browser or a stored saved view, reduced to a valid filter set. Unknown keys are dropped. */
export function parseInboxFilterSet(input: unknown): InboxFilterSet {
  const v = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const str = (x: unknown, re: RegExp) => (typeof x === "string" && re.test(x) ? x : null);
  return {
    view: pick(v.view, INBOX_VIEW_KEYS) ?? "all",
    within: pick(v.within, INBOX_WITHIN_KEYS),
    search: typeof v.search === "string" ? v.search.trim().slice(0, 120) : "",
    tag: typeof v.tag === "string" ? str(v.tag.trim().toLowerCase(), TAG) : null,
    teamId: str(v.teamId, ID),
    assigneeId: str(v.assigneeId, ID),
    account: str(v.account, ACCOUNT),
    status: pick(v.status, LIFECYCLE_FILTERS),
    // "newest" is the default order, stored as null so it never makes a list look filtered.
    sort: pick(v.sort, ["oldest", "waiting"] as const),
    lastSender: pick(v.lastSender, INBOX_LAST_SENDER_KEYS),
    mood: pick(v.mood, INBOX_MOOD_KEYS),
  };
}

/** True when nothing but the default "open conversations" view is asked for. */
export function isDefaultInboxFilters(f: InboxFilterSet): boolean {
  return f.view === "all" && !f.within && !f.search && !f.tag && !f.teamId && !f.assigneeId && !f.account && !f.status && !f.sort && !f.lastSender && !f.mood;
}

/** A stable key for "which query does this result answer". */
export function inboxFilterKey(f: InboxFilterSet): string {
  return [f.view, f.within ?? "", f.search, f.tag ?? "", f.teamId ?? "", f.assigneeId ?? "", f.account ?? "", f.status ?? "", f.sort ?? "", f.lastSender ?? "", f.mood ?? ""].join("|");
}

/** The priorities a view asks for, or null when it does not filter by priority. */
export function priorityFilterOf(view: InboxViewKey): ("HIGH" | "URGENT")[] | null {
  if (view === "urgent") return ["URGENT"];
  if (view === "high") return ["HIGH", "URGENT"];
  return null;
}

export const SAVED_VIEW_NAME_MAX = 60;

/** What `orderInboxItems` needs of a row. Times are ISO strings or null. */
export interface InboxOrderable {
  key: string;
  lastMessageAt: string | null;
  needsReply: boolean;
  /** When the customer started waiting (their first message after our last reply), for rows that need a reply. */
  waitingSince: string | null;
}

const byNewest = (a: InboxOrderable, b: InboxOrderable) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? "") || a.key.localeCompare(b.key);

/**
 * The list order for a sort key. Stable and total: every tie is broken by the conversation key, so two refreshes of
 * the same data list it the same way. "waiting": conversations that need a reply first, the longest wait first (a
 * row needing a reply with no known start time sorts after those with one), then everything else newest first.
 * Rows without any message sort last under "oldest", as under "newest".
 */
export function orderInboxItems<T extends InboxOrderable>(items: readonly T[], sort: InboxFilterSet["sort"]): T[] {
  const list = [...items];
  if (sort === "oldest") {
    return list.sort((a, b) => {
      if (!a.lastMessageAt || !b.lastMessageAt) return (a.lastMessageAt ? -1 : 0) - (b.lastMessageAt ? -1 : 0) || a.key.localeCompare(b.key);
      return a.lastMessageAt.localeCompare(b.lastMessageAt) || a.key.localeCompare(b.key);
    });
  }
  if (sort === "waiting") {
    return list.sort((a, b) => {
      if (a.needsReply !== b.needsReply) return a.needsReply ? -1 : 1;
      if (!a.needsReply) return byNewest(a, b);
      if (!a.waitingSince || !b.waitingSince) return (a.waitingSince ? -1 : 0) - (b.waitingSince ? -1 : 0) || byNewest(a, b);
      return a.waitingSince.localeCompare(b.waitingSince) || a.key.localeCompare(b.key);
    });
  }
  return list.sort(byNewest);
}
