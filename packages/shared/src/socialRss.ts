/**
 * Social Studio RSS import (SOCIAL_STUDIO.md §Automation): the pure half. It reads an RSS 2.0 or Atom feed
 * into items and turns a new item into draft text. An imported item only ever becomes a DRAFT; it still
 * goes through approval and scheduling like any post. No XML library: a feed is read with a small,
 * bounded scanner that understands the few elements needed and ignores everything else.
 */

export interface FeedItem {
  /** A stable id: the item's guid / Atom id, else its link, else its title. */
  guid: string;
  title: string;
  link: string | null;
  summary: string;
  publishedAt: Date | null;
}

const MAX_ITEMS = 50;

function decode(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d{1,7});/g, (_, n: string) => safeChar(Number(n)))
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, n: string) => safeChar(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function safeChar(code: number): string {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
}

const stripTags = (html: string) =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();

function tag(block: string, names: string[]): string | null {
  for (const name of names) {
    const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(block);
    if (m) return m[1]!;
  }
  return null;
}

function atomLink(block: string): string | null {
  const links = [...block.matchAll(/<link\b([^>]*)\/?>/gi)].map((m) => m[1]!);
  for (const attrs of links) {
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    const rel = /\brel\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ?? "alternate";
    if (href && rel === "alternate") return decode(href);
  }
  return null;
}

const httpUrl = (v: string | null) => (v && /^https?:\/\/[^\s<>"]+$/i.test(v.trim()) ? v.trim().slice(0, 1000) : null);

/** The feed's items, newest first as the feed lists them; at most 50; anything unreadable is skipped. */
export function parseFeed(xml: string): FeedItem[] {
  const text = xml.slice(0, 2_000_000);
  const blocks = [...text.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((m) => m[1]!);
  const atom = blocks.length === 0;
  const entries = atom ? [...text.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)].map((m) => m[1]!) : blocks;
  const items: FeedItem[] = [];
  for (const block of entries.slice(0, MAX_ITEMS)) {
    const title = stripTags(decode(tag(block, ["title"]) ?? "")).replace(/\s+/g, " ").slice(0, 300);
    const link = atom ? atomLink(block) : httpUrl(decode(tag(block, ["link"]) ?? "")) ?? atomLink(block);
    const summary = stripTags(decode(tag(block, atom ? ["summary", "content"] : ["description", "content:encoded", "summary"]) ?? "")).slice(0, 2000);
    const dateText = tag(block, atom ? ["published", "updated"] : ["pubDate", "dc:date", "published"]);
    const parsed = dateText ? Date.parse(decode(dateText).trim()) : NaN;
    const guid = (decode(tag(block, atom ? ["id"] : ["guid"]) ?? "").trim() || link || title).slice(0, 500);
    if (!guid || (!title && !link)) continue;
    items.push({ guid, title, link: httpUrl(link), summary, publishedAt: Number.isNaN(parsed) ? null : new Date(parsed) });
  }
  return items;
}

/** A new item as draft text: its title, a short summary when asked, and its link. */
export function feedItemText(item: FeedItem, opts: { includeSummary: boolean; prefix?: string | null }): string {
  const parts: string[] = [];
  if (opts.prefix?.trim()) parts.push(opts.prefix.trim().slice(0, 300));
  if (item.title) parts.push(item.title);
  if (opts.includeSummary && item.summary) {
    const s = item.summary.replace(/\s+/g, " ").trim();
    parts.push(s.length > 280 ? `${s.slice(0, 277).trimEnd()}…` : s);
  }
  if (item.link) parts.push(item.link);
  return parts.join("\n\n");
}

/** A feed address: http(s), no credentials, a normal port. The DNS/private-network check is the server's. */
export function checkFeedUrl(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "Enter the feed's full address, like https://example.com/feed." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, reason: "A feed address starts with https:// or http://." };
  if (url.username || url.password) return { ok: false, reason: "The address must not contain a user name or password." };
  if (url.port && !["80", "443"].includes(url.port)) return { ok: false, reason: "Only the standard web ports are allowed." };
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local") || !host.includes(".")) return { ok: false, reason: "That is not a public address." };
  url.hash = "";
  return { ok: true, url: url.toString().slice(0, 1000) };
}
