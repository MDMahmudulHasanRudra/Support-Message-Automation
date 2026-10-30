import { AlertTriangle, CalendarRange, Plus } from "lucide-react";
import Link from "@/components/ProjectLink";
import { ButtonLink, Card, EmptyState, PageHeader, SectionHeader, StatTile } from "@/components/ui";
import { requireAccess } from "@/server/authorize";
import { hasPermission } from "@/server/permissions";
import { listSocialAccounts } from "@/server/social/accounts";
import { listSocialPosts, socialStatusCounts } from "@/server/social/posts";
import { mediaUsage } from "@/server/social/media";
import { displayZone, formatBytes, formatInZone, platformShort, PostStatusBadge } from "./socialUi";

export const metadata = { title: "Social Studio" };

/**
 * Social Studio's overview (SOCIAL_STUDIO.md §Pages): what needs a person (approvals, failures, unknown
 * outcomes), what is coming up, account health and usage. Every number links to the rows behind it.
 */
export default async function SocialOverviewPage({ searchParams }: { searchParams: Promise<{ tz?: string }> }) {
  const session = await requireAccess("social.view", "SOCIAL_STUDIO");
  const tz = displayZone((await searchParams).tz);
  const [counts, accounts, upcoming, attention, usage, canManageAccounts, canEdit] = await Promise.all([
    socialStatusCounts(),
    listSocialAccounts(),
    listSocialPosts({ view: "scheduled", take: 8 }),
    listSocialPosts({ view: "failed", take: 8 }),
    mediaUsage(),
    hasPermission(session, "social.manage"),
    hasPermission(session, "social.edit"),
  ]);
  const count = (...s: string[]) => s.reduce((n, k) => n + (counts[k] ?? 0), 0);
  const healthy = accounts.filter((a) => a.status === "ACTIVE" && a.enabled).length;
  const unhealthy = accounts.filter((a) => a.status !== "ACTIVE");

  return (
    <div>
      <PageHeader
        title="Social Studio"
        description="Write, approve and schedule posts for your Facebook Pages and Instagram accounts. Nothing is published without a person's approval."
        actions={
          canEdit ? (
            <ButtonLink href="/social/new" variant="primary" size="md">
              <Plus className="size-4" aria-hidden /> Create post
            </ButtonLink>
          ) : null
        }
      />

      {accounts.length === 0 ? (
        <Card className="mb-6">
          <EmptyState icon={<CalendarRange className="size-5" aria-hidden />}>
            No account is connected yet.{" "}
            {canManageAccounts ? (
              <Link href="/social/accounts" className="link">
                Connect Facebook / Instagram
              </Link>
            ) : (
              "Ask someone who manages Social Studio to connect Facebook or Instagram."
            )}
          </EmptyState>
        </Card>
      ) : null}

      <div className="mb-8 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatTile label="Waiting for approval" value={count("IN_REVIEW")} tone={count("IN_REVIEW") ? "accent" : "neutral"} href="/social/posts?view=approvals" />
        <StatTile label="Approved, not scheduled" value={count("APPROVED")} href="/social/posts?view=approvals" />
        <StatTile label="Scheduled" value={count("SCHEDULED")} href="/social/posts?view=scheduled" />
        <StatTile label="Published" value={count("PUBLISHED", "PARTIAL")} tone="success" href="/social/posts?view=published" />
        <StatTile label="Failed" value={count("FAILED")} tone={count("FAILED") ? "danger" : "neutral"} href="/social/posts?view=failed" />
        <StatTile label="Outcome unknown" value={count("UNKNOWN")} tone={count("UNKNOWN") ? "warning" : "neutral"} hint="A person should check these" href="/social/posts?view=failed" />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section>
          <SectionHeader title="Coming up" description={`Times in ${tz}.`} action={<Link href="/social/calendar" className="link text-sm">Calendar</Link>} />
          <Card>
            {upcoming.length === 0 ? (
              <EmptyState>Nothing is scheduled.</EmptyState>
            ) : (
              <ul className="divide-y divide-[var(--color-border)]">
                {upcoming.map((p) => (
                  <li key={p.id} className="flex items-start justify-between gap-3 px-4 py-3 text-sm">
                    <div className="min-w-0">
                      <Link href={`/social/posts/${p.id}`} className="font-medium hover:underline">
                        {p.title ?? p.excerpt.slice(0, 70) ?? "Untitled"}
                      </Link>
                      <p className="text-xs text-[color:var(--color-muted-foreground)]">{p.accounts.map((a) => `${platformShort(a.platform)} · ${a.name}`).join(", ")}</p>
                    </div>
                    <span className="shrink-0 text-xs tabular text-[color:var(--color-muted-foreground)]">{formatInZone(p.when, tz)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </section>

        <section>
          <SectionHeader title="Needs a person" description="Failed publications, and ones whose outcome is not known." />
          <Card>
            {attention.length === 0 ? (
              <EmptyState>Nothing failed.</EmptyState>
            ) : (
              <ul className="divide-y divide-[var(--color-border)]">
                {attention.map((p) => (
                  <li key={p.id} className="flex items-start justify-between gap-3 px-4 py-3 text-sm">
                    <div className="min-w-0">
                      <Link href={`/social/posts/${p.id}`} className="font-medium hover:underline">
                        {p.title ?? p.excerpt.slice(0, 70)}
                      </Link>
                      <p className="text-xs text-[color:var(--color-muted-foreground)]">{p.accounts.map((a) => a.name).join(", ")}</p>
                    </div>
                    <PostStatusBadge status={p.status} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </section>

        <section>
          <SectionHeader title="Accounts" description={`${healthy} of ${accounts.length} ready to publish.`} action={<Link href="/social/accounts" className="link text-sm">Manage</Link>} />
          <Card>
            {unhealthy.length === 0 ? (
              <p className="px-4 py-3 text-sm text-[color:var(--color-muted-foreground)]">{accounts.length ? "Every account is ready." : "No accounts yet."}</p>
            ) : (
              <ul className="divide-y divide-[var(--color-border)]">
                {unhealthy.map((a) => (
                  <li key={a.id} className="flex items-start gap-2 px-4 py-3 text-sm">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[color:var(--color-warning)]" aria-hidden />
                    <span>
                      <span className="font-medium">{a.name}</span> ({platformShort(a.platform)}): {a.lastError ?? "needs attention"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </section>

        <section>
          <SectionHeader title="Usage" />
          <Card className="space-y-2 p-4 text-sm">
            <p>
              Media library: <span className="tabular font-medium">{formatBytes(usage.usedBytes)}</span> of {formatBytes(usage.allowanceBytes)} ({usage.files} files).{" "}
              <Link href="/social/media" className="link">
                Open
              </Link>
            </p>
            <p>
              Drafts: <span className="tabular font-medium">{count("DRAFT")}</span> ·{" "}
              <Link href="/social/posts?view=drafts" className="link">
                see drafts
              </Link>
            </p>
            <p className="text-xs text-[color:var(--color-muted-foreground)]">Instagram allows each account a limited number of API publications per 24 hours; Social Studio checks it before publishing and waits when it is reached.</p>
          </Card>
        </section>
      </div>
    </div>
  );
}
