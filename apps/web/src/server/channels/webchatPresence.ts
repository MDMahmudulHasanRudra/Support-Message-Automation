/**
 * Who is on a customer's website right now (WEBSITE_CHAT.md §Live board). Anonymous and in memory: a random id the
 * browser made up and the page's path, gone two minutes after the last ping and at every restart. It identifies
 * nobody, is never written to the database, and exists only for "12 people are on your site".
 */
const LIVE_MS = 120_000;
const MAX_PER_WIDGET = 5000;

interface Entry {
  page: string | null;
  firstSeen: number;
  lastSeen: number;
  chatting: boolean;
}

// One table for the whole process: the page and the API route are bundled separately.
const holder = globalThis as unknown as { __webchatPresence?: Map<string, Map<string, Entry>> };
const widgets = (holder.__webchatPresence ??= new Map());

export function recordPresence(connectionId: string, id: unknown, page: string | null, chatting: boolean, now = Date.now()): void {
  if (typeof id !== "string" || !/^[a-z0-9]{8,40}$/.test(id)) return;
  const visitors = widgets.get(connectionId) ?? new Map<string, Entry>();
  widgets.set(connectionId, visitors);
  if (!visitors.has(id) && visitors.size >= MAX_PER_WIDGET) {
    for (const [key, entry] of visitors) if (now - entry.lastSeen > LIVE_MS) visitors.delete(key);
    if (visitors.size >= MAX_PER_WIDGET) return;
  }
  const known = visitors.get(id);
  visitors.set(id, { page: page ?? known?.page ?? null, firstSeen: known?.firstSeen ?? now, lastSeen: now, chatting });
}

export interface WidgetPresence {
  online: number;
  chatting: number;
  pages: Array<{ page: string; count: number }>;
}

export function presenceFor(connectionIds: string[], now = Date.now()): WidgetPresence {
  let online = 0;
  let chatting = 0;
  const pages = new Map<string, number>();
  for (const id of connectionIds) {
    const visitors = widgets.get(id);
    if (!visitors) continue;
    for (const [key, entry] of visitors) {
      if (now - entry.lastSeen > LIVE_MS) {
        visitors.delete(key);
        continue;
      }
      online += 1;
      if (entry.chatting) chatting += 1;
      if (entry.page) pages.set(entry.page, (pages.get(entry.page) ?? 0) + 1);
    }
  }
  return { online, chatting, pages: [...pages].map(([page, count]) => ({ page, count })).sort((a, b) => b.count - a.count).slice(0, 6) };
}
