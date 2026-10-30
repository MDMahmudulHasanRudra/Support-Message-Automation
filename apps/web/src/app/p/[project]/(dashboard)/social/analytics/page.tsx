import { Download, ExternalLink } from "lucide-react";
import { zonedDay, zonedLocalToUtc } from "@support-automation/shared";
import Link from "@/components/ProjectLink";
import { ButtonLink, Card, EmptyState, PageHeader, SectionHeader, Table, Td, Th } from "@/components/ui";
import { requireAccess } from "@/server/authorize";
import { listSocialAccounts } from "@/server/social/accounts";
import { listCampaigns } from "@/server/social/library";
import { loadSocialAnalytics } from "@/server/social/analytics";
import { displayZone, formatInZone, platformShort } from "../socialUi";

export const metadata = { title: "Social analytics" };

function addDays(key: string, n: number): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
}

/**
 * What was published and how it did, as each platform reports it (SOCIAL_STUDIO.md §Analytics). Counts
 * are read from the platform every few hours for two weeks after publishing; a metric the platform does
 * not give is shown as "—", never as zero, and a total says how many posts it covers.
 */
export default async function SocialAnalyticsPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string; account?: string; campaign?: string; tz?: string }> }) {
  await requireAccess("social.view", "SOCIAL_STUDIO");
  const sp = await searchParams;
  const tz = displayZone(sp.tz);
  const today = zonedDay(new Date(), tz);
  const fromDay = sp.from && /^\d{4}-\d{2}-\d{2}$/.test(sp.from) ? sp.from : addDays(today, -29);
  const toDay = sp.to && /^\d{4}-\d{2}-\d{2}$/.test(sp.to) ? sp.to : today;
  const from = zonedLocalToUtc(`${fromDay}T00:00`, tz)!;
  const to = zonedLocalToUtc(`${addDays(toDay, 1)}T00:00`, tz)!;
  const [data, accounts, campaigns] = await Promise.all([
    loadSocialAnalytics({ from, to, accountId: sp.account || undefined, campaignId: sp.campaign || undefined }),
    listSocialAccounts({ includeRemoved: true }),
    listCampaigns({ includeArchived: true }),
  ]);
  const query = new URLSearchParams({ from: fromDay, to: toDay, tz, ...(sp.account ? { account: sp.account } : {}), ...(sp.campaign ? { campaign: sp.campaign } : {}) });

  return (
    <div>
      <PageHeader
        title="Analytics"
        description="Published posts and the counts each platform reports for them. Nothing is estimated."
        actions={
          <ButtonLink href={`/api/social/export?${query}`} download>
            <Download className="size-4" aria-hidden /> Export CSV
          </ButtonLink>
        }
      />
      <form method="get" className="mb-6 flex flex-wrap items-end gap-3 text-sm">
        <label>
          <span className="mb-1 block text-xs text-[color:var(--color-muted-foreground)]">From</span>
          <input type="date" name="from" defaultValue={fromDay} className="h-9 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2" />
        </label>
        <label>
          <span className="mb-1 block text-xs text-[color:var(--color-muted-foreground)]">To</span>
          <input type="date" name="to" defaultValue={toDay} className="h-9 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2" />
        </label>
        <select name="account" defaultValue={sp.account ?? ""} aria-label="Account" className="h-9 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2">
          <option value="">All accounts</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} ({platformShort(a.platform)})
            </option>
          ))}
        </select>
        <select name="campaign" defaultValue={sp.campaign ?? ""} aria-label="Campaign" className="h-9 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2">
          <option value="">All campaigns</option>
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <input type="hidden" name="tz" value={tz} />
        <button type="submit" className="h-9 rounded-[var(--radius-md)] border border-[var(--color-border)] px-3">
          Apply
        </button>
      </form>

      {data.rows.length === 0 ? (
        <EmptyState>Nothing was published in this period.</EmptyState>
      ) : (
        <div className="space-y-6">
          <section>
            <SectionHeader title="By account" description="Totals add up only the posts that have that count; the number in brackets is how many." />
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {data.byAccount.map((a) => (
                <Card key={`${a.platform}${a.account}`} className="p-4 text-sm">
                  <p className="font-medium">{a.account}</p>
                  <p className="mb-2 text-xs text-[color:var(--color-muted-foreground)]">
                    {platformShort(a.platform)} · {a.published} published
                  </p>
                  {a.metrics.length ? (
                    <ul className="space-y-0.5 tabular">
                      {a.metrics.map((m) => (
                        <li key={m.label}>
                          {m.label}: <span className="font-medium">{m.total.toLocaleString("en-US")}</span> <span className="text-xs text-[color:var(--color-muted-foreground)]">({m.over})</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-[color:var(--color-muted-foreground)]">No counts read yet.</p>
                  )}
                </Card>
              ))}
            </div>
          </section>
          <section>
            <SectionHeader title="Publications" />
            <Table>
              <thead>
                <tr>
                  <Th>Published ({tz})</Th>
                  <Th>Post</Th>
                  <Th>Account</Th>
                  {data.metricLabels.map((l) => (
                    <Th key={l}>{l}</Th>
                  ))}
                  <Th>Counts read</Th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => {
                  const byLabel = new Map(r.metrics.map((m) => [m.label, m.value]));
                  return (
                    <tr key={r.targetId}>
                      <Td className="tabular text-xs">{formatInZone(r.publishedAt, tz)}</Td>
                      <Td className="max-w-xs">
                        <Link href={`/social/posts/${r.postId}`} className="hover:underline">
                          {r.postTitle}
                        </Link>
                        {r.campaign ? <p className="text-xs text-[color:var(--color-muted-foreground)]">{r.campaign}</p> : null}
                      </Td>
                      <Td className="text-xs">
                        {r.account} · {platformShort(r.platform)}
                        {r.permalink ? (
                          <a href={r.permalink} target="_blank" rel="noopener noreferrer" className="ml-1 inline-flex align-middle" aria-label="Open the post">
                            <ExternalLink className="size-3" aria-hidden />
                          </a>
                        ) : null}
                      </Td>
                      {data.metricLabels.map((l) => (
                        <Td key={l} className="tabular">
                          {byLabel.has(l) ? byLabel.get(l)!.toLocaleString("en-US") : "—"}
                        </Td>
                      ))}
                      <Td className="text-xs text-[color:var(--color-muted-foreground)]">{r.metricsAt ? formatInZone(r.metricsAt, tz) : "not yet"}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </section>
        </div>
      )}
    </div>
  );
}
