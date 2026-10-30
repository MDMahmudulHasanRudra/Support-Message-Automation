import { globalPrisma } from "@/server/db";
import { runWithProject, type ActiveProject } from "@/server/projectContext";
import { disabledFeaturesFor } from "@/server/projectFeatures";
import { tenantOfCustomer } from "@/server/tenant";
import { publishTarget, reconcileUnknownTarget, recoverExpiredLease, refreshTargetMetrics } from "@/server/social/engine";
import { runFeed } from "@/server/social/rss";

/**
 * Social Studio's publishing worker (SOCIAL_STUDIO.md §Engine), in the APP process — never in the WhatsApp
 * worker, whose OpenWA sessions it neither needs nor touches. Several app instances may run it at once:
 * every job is claimed by a conditional update, so each is published by exactly one of them. Every 15 s,
 * overlap-guarded and never throwing:
 *   1. expired leases: re-queued when the request never left, otherwise UNKNOWN (engine.ts);
 *   2. due jobs: up to 25 per tick, oldest due first;
 *   3. unknown outcomes: looked for on the account every 3 minutes for 2 days, then left to a person;
 *   4. statistics of posts published in the last 14 days, refreshed every 6 hours, 20 per tick;
 *   5. RSS feeds due by their own interval (at least an hour), at most 10 per tick — they only make DRAFTS.
 * A suspended, archived or billing-held project, or one with Social Studio off, is skipped — its jobs
 * wait. SOCIAL_PROCESSOR_DISABLED=true leaves the worker off.
 */

const TICK_MS = 15_000;

async function operatingProject(projectId: string, cache: Map<string, ActiveProject | null>): Promise<ActiveProject | null> {
  if (cache.has(projectId)) return cache.get(projectId)!;
  const p = await globalPrisma.project.findUnique({ where: { id: projectId }, select: { id: true, slug: true, name: true, status: true, customerId: true, billingHoldAt: true } });
  let active: ActiveProject | null = null;
  if (p && p.status === "ACTIVE" && !p.billingHoldAt) {
    const project: ActiveProject = { id: p.id, slug: p.slug, name: p.name, status: p.status, tenant: await tenantOfCustomer(p.customerId) };
    // The feature switch is read through the customer-scoped client, so it is read INSIDE the project: a
    // background tick has no request, session or address that could name the customer.
    const off = await runWithProject(project, () => disabledFeaturesFor(p.id));
    if (!off.has("SOCIAL_STUDIO")) active = project;
  }
  cache.set(projectId, active);
  return active;
}

async function eachInProject<T extends { id: string; projectId: string }>(rows: T[], cache: Map<string, ActiveProject | null>, fn: (id: string) => Promise<unknown>, label: string): Promise<number> {
  let done = 0;
  for (const row of rows) {
    const project = await operatingProject(row.projectId, cache);
    if (!project) continue;
    try {
      await runWithProject(project, () => fn(row.id));
      done += 1;
    } catch (err) {
      console.error(`[social] ${label} failed`, (err as Error).name, (err as Error).message?.slice(0, 200));
    }
  }
  return done;
}

export async function socialTickOnce(now = new Date()): Promise<{ recovered: number; published: number; reconciled: number; metrics: number; feeds: number }> {
  const cache = new Map<string, ActiveProject | null>();
  const expired = await globalPrisma.socialPostTarget.findMany({ where: { status: "PUBLISHING", leaseExpiresAt: { lt: now } }, take: 25, select: { id: true, projectId: true } });
  const recovered = await eachInProject(expired, cache, (id) => recoverExpiredLease(id, now), "lease recovery");

  const due = await globalPrisma.socialPostTarget.findMany({
    where: { status: "DUE", dueAt: { lte: now }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
    orderBy: { dueAt: "asc" },
    take: 25,
    select: { id: true, projectId: true },
  });
  const published = await eachInProject(due, cache, (id) => publishTarget(id, new Date()), "publishing");

  const unknown = await globalPrisma.socialPostTarget.findMany({
    where: { status: "UNKNOWN", updatedAt: { gte: new Date(now.getTime() - 2 * 86_400_000) }, OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: new Date(now.getTime() - 3 * 60_000) } }] },
    take: 10,
    select: { id: true, projectId: true },
  });
  const reconciled = await eachInProject(unknown, cache, (id) => reconcileUnknownTarget(id, now), "reconciliation");

  const stale = await globalPrisma.socialPostTarget.findMany({
    where: { status: "PUBLISHED", publishedAt: { gte: new Date(now.getTime() - 14 * 86_400_000) }, OR: [{ metricsAt: null }, { metricsAt: { lt: new Date(now.getTime() - 6 * 3_600_000) } }] },
    orderBy: { metricsAt: { sort: "asc", nulls: "first" } },
    take: 20,
    select: { id: true, projectId: true },
  });
  const metrics = await eachInProject(stale, cache, (id) => refreshTargetMetrics(id, now), "statistics");

  const feedRows = await globalPrisma.socialRssFeed.findMany({
    where: { enabled: true, OR: [{ lastFetchedAt: null }, { lastFetchedAt: { lt: new Date(now.getTime() - 60 * 60_000) } }] },
    orderBy: { lastFetchedAt: { sort: "asc", nulls: "first" } },
    take: 25,
    select: { id: true, projectId: true, intervalMinutes: true, lastFetchedAt: true },
  });
  const dueFeeds = feedRows.filter((f) => !f.lastFetchedAt || f.lastFetchedAt.getTime() <= now.getTime() - f.intervalMinutes * 60_000).slice(0, 10);
  const feeds = await eachInProject(dueFeeds, cache, (id) => runFeed(id, now), "RSS import");
  return { recovered, published, reconciled, metrics, feeds };
}

let running = false;

export async function socialTick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await socialTickOnce();
  } catch (err) {
    console.error("[social] tick failed", (err as Error).name);
  } finally {
    running = false;
  }
}

let started = false;

export function startSocialProcessor(): void {
  if (started) return;
  started = true;
  const timer = setInterval(() => void socialTick(), TICK_MS);
  timer.unref?.();
}
