/**
 * WhatsApp Chat v2 (CHAT_UI_V2.md): paging a conversation's STORED history.
 *
 * A thread is ordered by `(timestampWa, id)`. The timestamp alone is not an order — WhatsApp stamps to
 * the second, so a burst of lines shares one — and paging on it alone either repeats or skips the
 * messages that tie at a page boundary. The row id breaks the tie, the same tiebreak on every query
 * (newest window, older pages, jump-to), so a message is in exactly one page.
 *
 * The cursor is opaque to the browser but deliberately boring: `<epoch ms>.<row id>`, validated
 * strictly when it comes back. It names a position, never a scope — the conversation it is read
 * against is always re-derived on the server, so a cursor from another project or account reaches
 * nothing (the query it feeds is confined to the conversation the server resolved).
 */

export interface ThreadPosition {
  /** `Message.timestampWa`, epoch milliseconds. */
  at: number;
  /** `Message.id` — the tiebreak. */
  id: string;
}

const CURSOR_RE = /^(\d{1,15})\.([A-Za-z0-9_-]{1,64})$/;

export function encodeThreadCursor(position: ThreadPosition): string {
  return `${Math.trunc(position.at)}.${position.id}`;
}

/** The position a cursor names, or null for anything that is not one this code wrote. */
export function decodeThreadCursor(raw: unknown): ThreadPosition | null {
  if (typeof raw !== "string" || raw.length > 90) return null;
  const match = CURSOR_RE.exec(raw);
  if (!match) return null;
  const at = Number(match[1]);
  if (!Number.isSafeInteger(at)) return null;
  return { at, id: match[2]! };
}

/** Ascending thread order: oldest first, row id as the tiebreak. */
export function compareThreadPosition(a: ThreadPosition, b: ThreadPosition): number {
  return a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Whether `a` is strictly older than `b` in thread order. */
export function isOlderThan(a: ThreadPosition, b: ThreadPosition): boolean {
  return compareThreadPosition(a, b) < 0;
}

/**
 * The oldest position among stored messages, or null when there are none. Queued (not yet stored)
 * entries are not positions in the stored history and must not be passed in.
 */
export function oldestPosition(positions: readonly ThreadPosition[]): ThreadPosition | null {
  let oldest: ThreadPosition | null = null;
  for (const p of positions) if (!oldest || isOlderThan(p, oldest)) oldest = p;
  return oldest;
}

/**
 * Merges pages of entries into one thread: one entry per id (a later list replaces an earlier copy —
 * the live window is passed last, so a refreshed state wins over a stale page) and ascending order.
 * Entries without a stored position (queued sends) sort by their own time with their id as tiebreak.
 */
export function mergeThreadPages<T extends { id: string; at: Date | number }>(...pages: ReadonlyArray<readonly T[]>): T[] {
  const byId = new Map<string, T>();
  for (const page of pages) for (const entry of page) byId.set(entry.id, entry);
  const time = (e: T) => (typeof e.at === "number" ? e.at : e.at.getTime());
  return [...byId.values()].sort((a, b) => compareThreadPosition({ at: time(a), id: a.id }, { at: time(b), id: b.id }));
}
