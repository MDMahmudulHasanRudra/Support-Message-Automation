import Link from "@/components/ProjectLink";
import { Card, PageHeader, SectionHeader } from "@/components/ui";
import { pageAccess } from "@/server/authorize";
import { listSocialAccounts } from "@/server/social/accounts";
import { listFeeds } from "@/server/social/rss";
import { formatInZone, platformShort } from "../socialUi";
import { FeedForm, FeedRowControls } from "./FeedControls";

export const metadata = { title: "Social automation" };

/**
 * Social Studio automation (SOCIAL_STUDIO.md §Automation): RSS / Atom feeds whose new items become drafts.
 * Drafts only — each still needs approval and scheduling. Scheduled and recurring publishing live on
 * the posts themselves; failures are on the Overview and in the System Log.
 */
export default async function SocialAutomationPage() {
  const { canManage } = await pageAccess("social.view", "social.manage", "SOCIAL_STUDIO");
  const [feeds, accounts] = await Promise.all([listFeeds(), listSocialAccounts()]);
  const accountOptions = accounts.filter((a) => a.status === "ACTIVE" && a.enabled).map((a) => ({ id: a.id, label: `${a.name} (${platformShort(a.platform)})` }));
  const names = new Map(accounts.map((a) => [a.id, a.name]));
  const tz = process.env.SOCIAL_DEFAULT_TIMEZONE?.trim() || "Asia/Dhaka";
  return (
    <div>
      <PageHeader title="Automation" description="Turn new items from your website's RSS or Atom feed into drafts. Nothing is published until a person approves and schedules it." />
      {canManage ? (
        <Card className="mb-6 p-4">
          <SectionHeader title="New feed" description="Only items published after the feed is added become drafts; the back catalogue is skipped." />
          <FeedForm value={{ name: "", url: "", accountIds: [], prefix: "", includeSummary: true, intervalMinutes: 360, enabled: true }} accounts={accountOptions} />
        </Card>
      ) : null}
      <SectionHeader title="Feeds" />
      {feeds.length === 0 ? (
        <p className="text-sm text-[color:var(--color-muted-foreground)]">No feeds yet.</p>
      ) : (
        <ul className="space-y-3">
          {feeds.map((f) => (
            <li key={f.id} className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm">
              <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium">
                    {f.name} {f.enabled ? null : <span className="text-xs text-[color:var(--color-muted-foreground)]">(off)</span>}
                  </p>
                  <p className="truncate text-xs text-[color:var(--color-muted-foreground)]">{f.url}</p>
                  <p className="text-xs text-[color:var(--color-subtle-foreground)]">
                    For {f.accountIds.map((id) => names.get(id) ?? "a removed account").join(", ") || "no account"} · every {f.intervalMinutes >= 60 ? `${f.intervalMinutes / 60} h` : `${f.intervalMinutes} min`} · {f.draftsCreated} draft(s) so far
                    {f.lastFetchedAt ? ` · checked ${formatInZone(f.lastFetchedAt, tz)}` : " · not checked yet"}
                  </p>
                  {f.lastError ? <p className="text-xs text-[color:var(--color-danger)]">{f.lastError}</p> : null}
                </div>
              </div>
              {f.items.length ? (
                <ul className="mb-2 space-y-0.5 text-xs">
                  {f.items.map((i) => (
                    <li key={i.id}>
                      {i.postId ? (
                        <Link href={`/social/posts/${i.postId}`} className="link">
                          {i.title}
                        </Link>
                      ) : (
                        <span>{i.title} (no draft)</span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : null}
              {canManage ? (
                <FeedRowControls
                  feed={{ id: f.id, name: f.name, url: f.url, accountIds: f.accountIds, prefix: f.prefix ?? "", includeSummary: f.includeSummary, intervalMinutes: f.intervalMinutes, enabled: f.enabled }}
                  accounts={accountOptions}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
