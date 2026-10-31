/**
 * The unified inbox's filter set (INBOX_WORKSPACE.md § Inbox): one validated shape shared by the list,
 * saved views and bulk selection, so a saved view can only ever hold what the list itself accepts.
 * A filter only NARROWS what the viewer can already read — it is never an access rule.
 */

export const INBOX_VIEW_KEYS = ["all", "mine", "unassigned", "unread", "needs-reply", "high", "urgent", "closed"] as const;
export type InboxViewKey = (typeof INBOX_VIEW_KEYS)[number];

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
}

export const EMPTY_INBOX_FILTERS: InboxFilterSet = { view: "all", within: null, search: "", tag: null, teamId: null, assigneeId: null, account: null };

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
  };
}

/** True when nothing but the default "open conversations" view is asked for. */
export function isDefaultInboxFilters(f: InboxFilterSet): boolean {
  return f.view === "all" && !f.within && !f.search && !f.tag && !f.teamId && !f.assigneeId && !f.account;
}

/** A stable key for "which query does this result answer". */
export function inboxFilterKey(f: InboxFilterSet): string {
  return [f.view, f.within ?? "", f.search, f.tag ?? "", f.teamId ?? "", f.assigneeId ?? "", f.account ?? ""].join("|");
}

/** The priorities a view asks for, or null when it does not filter by priority. */
export function priorityFilterOf(view: InboxViewKey): ("HIGH" | "URGENT")[] | null {
  if (view === "urgent") return ["URGENT"];
  if (view === "high") return ["HIGH", "URGENT"];
  return null;
}

export const SAVED_VIEW_NAME_MAX = 60;
