import type { SocialMetricValue } from "@support-automation/shared";
import { prisma } from "@/server/db";

/**
 * Social Studio analytics (SOCIAL_STUDIO.md §Analytics): what was published in a period, per account and
 * campaign, with the platform's own counts as last read. One loader serves the page and the CSV export,
 * so the two cannot disagree. Nothing is estimated: a metric a platform did not return is absent, never 0,
 * and every count says when it was read.
 */

export interface SocialAnalyticsRow {
  targetId: string;
  postId: string;
  postTitle: string;
  campaign: string | null;
  account: string;
  platform: string;
  publishedAt: string;
  permalink: string | null;
  metrics: SocialMetricValue[];
  metricsAt: string | null;
}

export interface SocialAnalytics {
  rows: SocialAnalyticsRow[];
  /** Per account: publications, and per metric the sum over publications that HAVE that metric (with how many). */
  byAccount: Array<{ account: string; platform: string; published: number; metrics: Array<{ label: string; total: number; over: number }> }>;
  metricLabels: string[];
}

export async function loadSocialAnalytics(filter: { from: Date; to: Date; accountId?: string; campaignId?: string }): Promise<SocialAnalytics> {
  const targets = await prisma.socialPostTarget.findMany({
    where: {
      status: "PUBLISHED",
      publishedAt: { gte: filter.from, lt: filter.to },
      ...(filter.accountId ? { accountId: filter.accountId } : {}),
      ...(filter.campaignId ? { post: { campaignId: filter.campaignId } } : {}),
    },
    orderBy: { publishedAt: "desc" },
    take: 5000,
    select: {
      id: true,
      postId: true,
      publishedAt: true,
      permalink: true,
      metrics: true,
      metricsAt: true,
      account: { select: { name: true, platform: true } },
      post: { select: { title: true, content: true, campaign: { select: { name: true } } } },
    },
  });
  const rows: SocialAnalyticsRow[] = targets.map((t) => ({
    targetId: t.id,
    postId: t.postId,
    postTitle: t.post.title ?? (t.post.content.replace(/\s+/g, " ").trim().slice(0, 80) || "Untitled"),
    campaign: t.post.campaign?.name ?? null,
    account: t.account.name,
    platform: t.account.platform,
    publishedAt: t.publishedAt!.toISOString(),
    permalink: t.permalink,
    metrics: Array.isArray(t.metrics) ? (t.metrics as unknown as SocialMetricValue[]).filter((m) => m && typeof m.label === "string" && Number.isFinite(m.value)) : [],
    metricsAt: t.metricsAt?.toISOString() ?? null,
  }));
  const labels = new Set<string>();
  const accounts = new Map<string, { account: string; platform: string; published: number; metrics: Map<string, { total: number; over: number }> }>();
  for (const r of rows) {
    const key = `${r.platform}|${r.account}`;
    const a = accounts.get(key) ?? { account: r.account, platform: r.platform, published: 0, metrics: new Map() };
    a.published += 1;
    for (const m of r.metrics) {
      labels.add(m.label);
      const cur = a.metrics.get(m.label) ?? { total: 0, over: 0 };
      cur.total += m.value;
      cur.over += 1;
      a.metrics.set(m.label, cur);
    }
    accounts.set(key, a);
  }
  return {
    rows,
    byAccount: [...accounts.values()].map((a) => ({ account: a.account, platform: a.platform, published: a.published, metrics: [...a.metrics.entries()].map(([label, v]) => ({ label, ...v })) })),
    metricLabels: [...labels].sort(),
  };
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** The same rows as the page, as CSV (formula-leading cells are neutralised for spreadsheets). */
export function socialAnalyticsCsv(data: SocialAnalytics): string {
  const header = ["Published at (UTC)", "Account", "Platform", "Post", "Campaign", "Link", ...data.metricLabels, "Statistics read at (UTC)"];
  const lines = [header.map(csvCell).join(",")];
  for (const r of data.rows) {
    const byLabel = new Map(r.metrics.map((m) => [m.label, m.value]));
    lines.push([r.publishedAt, r.account, r.platform, r.postTitle, r.campaign ?? "", r.permalink ?? "", ...data.metricLabels.map((l) => (byLabel.has(l) ? byLabel.get(l) : "")), r.metricsAt ?? ""].map(csvCell).join(","));
  }
  return `${lines.join("\n")}\n`;
}
