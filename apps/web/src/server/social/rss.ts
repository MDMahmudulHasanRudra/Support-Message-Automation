import { lookup } from "node:dns/promises";
import { Prisma } from "@prisma/client";
import { checkFeedUrl, feedItemText, isPrivateAddress, parseFeed, planPublishAccounts } from "@support-automation/shared";
import { prisma } from "@/server/db";
import { saveSocialDraft, SocialRefusal } from "./posts";

/**
 * RSS / Atom import (SOCIAL_STUDIO.md §Automation): new feed items become DRAFTS for chosen accounts. A
 * draft is never published by itself — it is approved and scheduled like any post. The fetch is the
 * dangerous part, so it:
 *   - goes only to a public address (every resolved address checked, and again for each redirect, at
 *     most three);
 *   - has a 15-second deadline and a 2 MB cap;
 *   - accepts only feed-like content types.
 * Each item is recorded once (feed + guid) BEFORE its draft is made, so a race or a retry can never make
 * two drafts of one item.
 */

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_NEW_PER_RUN = 5;
const FEED_TYPES = /(xml|rss|atom|text\/plain)/i;

export class FeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedError";
  }
}

async function assertPublicHost(url: URL): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isPrivateAddress(host)) throw new FeedError("The feed address is on a private network.");
  let addresses: string[];
  try {
    addresses = (await lookup(host, { all: true })).map((a) => a.address);
  } catch {
    throw new FeedError("The feed's address could not be found.");
  }
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a))) throw new FeedError("The feed address resolves to a private network, so it is not fetched.");
}

export async function fetchFeed(rawUrl: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const checked = checkFeedUrl(rawUrl);
  if (!checked.ok) throw new FeedError(checked.reason);
  let url = new URL(checked.url);
  for (let hop = 0; hop < 4; hop++) {
    await assertPublicHost(url);
    let response: Response;
    try {
      response = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(15_000), headers: { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" }, cache: "no-store" });
    } catch {
      throw new FeedError("The feed could not be reached.");
    }
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get("location");
      if (!next) throw new FeedError("The feed redirected without an address.");
      const checkedNext = checkFeedUrl(new URL(next, url).toString());
      if (!checkedNext.ok) throw new FeedError(`The feed redirected somewhere not allowed: ${checkedNext.reason}`);
      url = new URL(checkedNext.url);
      continue;
    }
    if (!response.ok) throw new FeedError(`The feed answered ${response.status}.`);
    const type = response.headers.get("content-type") ?? "";
    if (type && !FEED_TYPES.test(type)) throw new FeedError("That address is not a feed (it did not answer with XML).");
    if (Number(response.headers.get("content-length") ?? 0) > MAX_BYTES) throw new FeedError("The feed is too large.");
    const reader = response.body?.getReader();
    if (!reader) return "";
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new FeedError("The feed is too large.");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
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
export async function runFeed(feedId: string, now = new Date(), fetchImpl?: typeof fetch): Promise<{ drafts: number; error: string | null }> {
  const feed = await prisma.socialRssFeed.findFirst({ where: { id: feedId } });
  if (!feed) return { drafts: 0, error: "The feed no longer exists." };
  let xml: string;
  try {
    xml = await fetchFeed(feed.url, fetchImpl);
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
    let row: { id: string };
    try {
      row = await prisma.socialRssItem.create({ data: { feedId, guid: item.guid, title: item.title.slice(0, 300) || "(untitled)", link: item.link }, select: { id: true } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue;
      throw err;
    }
    try {
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
      );
      await prisma.socialRssItem.update({ where: { id: row.id }, data: { postId: saved.id } });
      drafts += 1;
    } catch (err) {
      error = err instanceof SocialRefusal ? `A draft could not be made: ${err.message}` : "A draft could not be made.";
      break;
    }
  }
  await prisma.socialRssFeed.update({ where: { id: feedId }, data: { lastFetchedAt: now, lastError: error, draftsCreated: { increment: drafts } } });
  return { drafts, error };
}
