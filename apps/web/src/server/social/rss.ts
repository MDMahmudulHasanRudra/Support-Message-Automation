import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import type { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { checkFeedUrl, feedItemText, isPrivateAddress, parseFeed, planPublishAccounts } from "@support-automation/shared";
import { prisma } from "@/server/db";
import { saveSocialDraft, SocialRefusal } from "./posts";

/**
 * RSS / Atom import (SOCIAL_STUDIO.md §Automation): new feed items become DRAFTS for chosen accounts. A
 * draft is never published by itself — it is approved and scheduled like any post. The fetch is the
 * dangerous part, so it:
 *   - connects only to a public address, and to EXACTLY the address that was checked: the name is resolved
 *     once per connection, inside the connection itself (a custom `lookup`), every address it returns is
 *     checked, and the socket is opened to one of them — there is no second resolution a DNS answer could
 *     change in between (DNS rebinding). No shared connection pool, no proxy;
 *   - follows at most three redirects by hand, each re-checked as a new address;
 *   - has a 15-second deadline and a 2 MB cap (after decompression);
 *   - accepts only feed-like content types.
 * Each item and its draft are written in ONE transaction, so a failure leaves nothing recorded and the item
 * is simply tried again next time; the unique (feed, guid) row, locked while its draft is made, makes sure a
 * concurrent run can never make a second draft of it.
 */

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_NEW_PER_RUN = 5;
const MAX_REDIRECTS = 3;
const DEADLINE_MS = 15_000;
const FEED_TYPES = /(xml|rss|atom|text\/plain)/i;

export class FeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedError";
  }
}

/** Name resolution, as `dns.lookup(name, { all: true })` answers it. */
export type FeedResolve = (hostname: string, callback: (err: Error | null, addresses: LookupAddress[]) => void) => void;

export interface FeedFetchOptions {
  /** The resolver (tests). Defaults to the system's. */
  resolve?: FeedResolve;
  /** Which addresses may be connected to (tests). Defaults to public addresses only. */
  allowAddress?: (address: string) => boolean;
  /** Called with every address handed to a connection (tests). */
  onConnect?: (hostname: string, address: string) => void;
  /** Tests only: connect to this port instead of the address's own (80/443, which a test server cannot use). */
  portOverride?: number;
}

type ConnectOptions = Required<Pick<FeedFetchOptions, "resolve" | "allowAddress">> & Pick<FeedFetchOptions, "onConnect" | "portOverride">;
type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

const systemResolve: FeedResolve = (hostname, callback) => dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => callback(err, addresses ?? []));
const publicOnly = (address: string) => !isPrivateAddress(address);

/** The connection's own resolver: every answer is checked, and the socket connects to what it returns. */
function pinnedLookup(options: ConnectOptions) {
  return (hostname: string, lookupOptions: { all?: boolean } | number | undefined, callback: LookupCallback) => {
    options.resolve(hostname, (err, addresses) => {
      if (err || addresses.length === 0) return callback(new FeedError("The feed's address could not be found."), "");
      if (addresses.some((a) => !options.allowAddress(a.address))) return callback(new FeedError("The feed address resolves to a private network, so it is not fetched."), "");
      for (const a of addresses) options.onConnect?.(hostname, a.address);
      if (typeof lookupOptions === "object" && lookupOptions?.all) callback(null, addresses);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}

function requestOnce(url: URL, signal: AbortSignal, options: ConnectOptions): Promise<IncomingMessage> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  // An address written as a literal is never resolved, so it is checked here instead.
  if (isIP(host) && !options.allowAddress(host)) return Promise.reject(new FeedError("The feed address is on a private network."));
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(url, {
      method: "GET",
      ...(options.portOverride ? { port: options.portOverride } : {}),
      agent: false,
      lookup: pinnedLookup(options) as unknown as http.RequestOptions["lookup"],
      signal,
      headers: { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml", "Accept-Encoding": "gzip, deflate, br", "User-Agent": "GetAssist-SocialStudio/1 (feed import)" },
    });
    req.on("response", resolve);
    req.on("error", (err) => {
      if (err instanceof FeedError) reject(err);
      else reject(new FeedError((err as Error).name === "AbortError" ? "The feed took too long to answer." : "The feed could not be reached."));
    });
    req.end();
  });
}

async function readCapped(response: IncomingMessage): Promise<string> {
  const encoding = String(response.headers["content-encoding"] ?? "identity").toLowerCase().trim();
  let stream: Readable = response;
  if (encoding === "gzip" || encoding === "x-gzip") stream = response.pipe(createGunzip());
  else if (encoding === "deflate") stream = response.pipe(createInflate());
  else if (encoding === "br") stream = response.pipe(createBrotliDecompress());
  else if (encoding !== "identity" && encoding !== "") {
    response.destroy();
    throw new FeedError("The feed answered in an encoding that is not supported.");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buf = chunk as Buffer;
      total += buf.byteLength;
      if (total > MAX_BYTES) throw new FeedError("The feed is too large.");
      chunks.push(buf);
    }
  } catch (err) {
    response.destroy();
    if (err instanceof FeedError) throw err;
    throw new FeedError("The feed could not be read completely.");
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function fetchFeed(rawUrl: string, options: FeedFetchOptions = {}): Promise<string> {
  const checked = checkFeedUrl(rawUrl);
  if (!checked.ok) throw new FeedError(checked.reason);
  const opts: ConnectOptions = { resolve: options.resolve ?? systemResolve, allowAddress: options.allowAddress ?? publicOnly, onConnect: options.onConnect, portOverride: options.portOverride };
  const signal = AbortSignal.timeout(DEADLINE_MS);
  let url = new URL(checked.url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await requestOnce(url, signal, opts);
    const status = response.statusCode ?? 0;
    if (status >= 300 && status < 400) {
      response.resume();
      const next = response.headers.location;
      if (!next) throw new FeedError("The feed redirected without an address.");
      const checkedNext = checkFeedUrl(new URL(next, url).toString());
      if (!checkedNext.ok) throw new FeedError(`The feed redirected somewhere not allowed: ${checkedNext.reason}`);
      url = new URL(checkedNext.url);
      continue;
    }
    if (status < 200 || status >= 300) {
      response.resume();
      throw new FeedError(`The feed answered ${status}.`);
    }
    const type = String(response.headers["content-type"] ?? "");
    if (type && !FEED_TYPES.test(type)) {
      response.resume();
      throw new FeedError("That address is not a feed (it did not answer with XML).");
    }
    if (Number(response.headers["content-length"] ?? 0) > MAX_BYTES) {
      response.destroy();
      throw new FeedError("The feed is too large.");
    }
    return readCapped(response);
  }
  throw new FeedError("The feed redirected too many times.");
}

export interface FeedInput {
  id?: string;
  name: string;
  url: string;
  accountIds: string[];
  prefix: string | null;
  includeSummary: boolean;
  intervalMinutes: number;
  enabled: boolean;
}

export async function saveFeed(input: FeedInput, username: string): Promise<{ id: string }> {
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new SocialRefusal("Give the feed a name.");
  const url = checkFeedUrl(input.url);
  if (!url.ok) throw new SocialRefusal(url.reason);
  const accounts = await prisma.socialAccount.findMany({ where: { id: { in: input.accountIds } }, select: { id: true, platform: true, status: true, enabled: true } });
  const plan = planPublishAccounts(input.accountIds, accounts);
  if (!plan.ok) throw new SocialRefusal(plan.reason);
  const data = {
    name,
    url: url.url,
    accountIds: plan.accounts.map((a) => a.id),
    prefix: input.prefix?.trim().slice(0, 300) || null,
    includeSummary: input.includeSummary,
    intervalMinutes: Math.min(1440, Math.max(60, Math.round(input.intervalMinutes) || 360)),
    enabled: input.enabled,
  };
  if (!input.id) return prisma.socialRssFeed.create({ data: { ...data, createdByUsername: username }, select: { id: true } });
  const updated = await prisma.socialRssFeed.updateMany({ where: { id: input.id }, data: { ...data, lastError: null } });
  if (updated.count === 0) throw new SocialRefusal("That feed no longer exists.");
  return { id: input.id };
}

export async function deleteFeed(id: string): Promise<void> {
  const removed = await prisma.socialRssFeed.deleteMany({ where: { id } });
  if (removed.count === 0) throw new SocialRefusal("That feed no longer exists.");
}

export async function listFeeds() {
  return prisma.socialRssFeed.findMany({ orderBy: { createdAt: "asc" }, include: { items: { orderBy: { seenAt: "desc" }, take: 5, select: { id: true, title: true, postId: true, seenAt: true } } } });
}

/** Reads one feed and turns its new items (since the feed was added) into drafts. */
export async function runFeed(feedId: string, now = new Date(), fetchOptions?: FeedFetchOptions): Promise<{ drafts: number; error: string | null }> {
  const feed = await prisma.socialRssFeed.findFirst({ where: { id: feedId } });
  if (!feed) return { drafts: 0, error: "The feed no longer exists." };
  let xml: string;
  try {
    xml = await fetchFeed(feed.url, fetchOptions);
  } catch (err) {
    const message = err instanceof FeedError ? err.message : "The feed could not be read.";
    await prisma.socialRssFeed.update({ where: { id: feedId }, data: { lastFetchedAt: now, lastError: message } });
    return { drafts: 0, error: message };
  }
  const items = parseFeed(xml).filter((i) => !i.publishedAt || i.publishedAt >= feed.importFrom);
  let drafts = 0;
  let error: string | null = null;
  for (const item of items) {
    if (drafts >= MAX_NEW_PER_RUN) break;
    const title = item.title.slice(0, 300) || "(untitled)";
    try {
      const made = await prisma.$transaction(async (tx) => {
        // Records the item if it is new. ON CONFLICT DO NOTHING waits for a concurrent run's uncommitted
        // insert of the same item instead of failing this transaction.
        await tx.socialRssItem.createMany({ data: [{ feedId, guid: item.guid, title, link: item.link }], skipDuplicates: true });
        // Takes the item only while it has no draft; the row stays locked until this commits, so a
        // concurrent run waits here and then finds the draft already made.
        const pending = await tx.socialRssItem.updateMany({ where: { feedId, guid: item.guid, postId: null }, data: { title, link: item.link } });
        if (pending.count === 0) return null;
        const saved = await saveSocialDraft(
          {
            title: `RSS: ${item.title}`.slice(0, 120),
            content: feedItemText(item, { includeSummary: feed.includeSummary, prefix: feed.prefix }),
            accountIds: feed.accountIds,
            mediaIds: [],
            variants: {},
            settings: {},
            publishMode: "SCHEDULE",
            scheduledAt: null,
            timezone: process.env.SOCIAL_DEFAULT_TIMEZONE?.trim() || "Asia/Dhaka",
            campaignId: null,
            aiAssisted: false,
          },
          `RSS · ${feed.name}`.slice(0, 100),
          tx,
        );
        await tx.socialRssItem.updateMany({ where: { feedId, guid: item.guid }, data: { postId: saved.id } });
        return saved.id;
      });
      if (made) drafts += 1;
    } catch (err) {
      // Nothing of this item was kept: it is tried again on the next run.
      error = err instanceof SocialRefusal ? `A draft could not be made: ${err.message} It will be tried again.` : "A draft could not be made. It will be tried again.";
      break;
    }
  }
  await prisma.socialRssFeed.update({ where: { id: feedId }, data: { lastFetchedAt: now, lastError: error, draftsCreated: { increment: drafts } } });
  return { drafts, error };
}
