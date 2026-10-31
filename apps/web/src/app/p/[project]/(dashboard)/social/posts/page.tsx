import { Plus } from "lucide-react";
import Link from "@/components/ProjectLink";
import { ButtonLink, EmptyState, PageHeader, SearchField, Table, Td, Th } from "@/components/ui";
import { pageAccess } from "@/server/authorize";
import { listSocialAccounts } from "@/server/social/accounts";
import { listCampaigns } from "@/server/social/library";
import { listSocialPosts, SOCIAL_LIST_VIEWS, type SocialListView } from "@/server/social/posts";
import { displayZone, formatInZone, platformShort, PostStatusBadge } from "../socialUi";

export const metadata = { title: "Social posts" };

const TITLES: Record<SocialListView, { title: string; description: string; empty: string }> = {
  all: { title: "All posts", description: "Every post in this project.", empty: "No posts yet." },
  drafts: { title: "Drafts", description: "Posts being written. Send one for approval when it is ready.", empty: "No drafts." },
  approvals: { title: "Approvals", description: "Waiting for approval, and approved posts not scheduled yet.", empty: "Nothing is waiting for approval." },
  scheduled: { title: "Scheduled", description: "Approved posts that will publish at their time.", empty: "Nothing is scheduled." },
  published: { title: "Published", description: "Posts published on every account, or on some of them.", empty: "Nothing has been published yet." },
  failed: { title: "Failed and unknown", description: "Publications that failed, or whose outcome a person should check.", empty: "Nothing failed." },
};

export default async function SocialPostsPage({ searchParams }: { searchParams: Promise<{ view?: string; search?: string; account?: string; campaign?: string; tz?: string }> }) {
  const { canManage: canEdit } = await pageAccess("social.view", "social.edit", "SOCIAL_STUDIO");
  const sp = await searchParams;
  const view: SocialListView = (SOCIAL_LIST_VIEWS as readonly string[]).includes(sp.view ?? "") ? (sp.view as SocialListView) : "all";
  const tz = displayZone(sp.tz);
  const [posts, accounts, campaigns] = await Promise.all([
    listSocialPosts({ view, q: sp.search, accountId: sp.account || undefined, campaignId: sp.campaign || undefined }),
    listSocialAccounts({ includeRemoved: true }),
    listCampaigns({ includeArchived: true }),
  ]);
  const t = TITLES[view];
  return (
    <div>
      <PageHeader
        title={t.title}
        description={t.description}
        actions={
          canEdit ? (
            <ButtonLink href="/social/new" variant="primary" size="md">
              <Plus className="size-4" aria-hidden /> Create post
            </ButtonLink>
          ) : null
        }
      />
      {/* Two sibling forms, never one inside the other (a nested form is invalid HTML and broke hydration). */}
      <div className="mb-4 flex flex-wrap items-end gap-3">
      <form className="flex flex-wrap items-end gap-3" method="get">
        <input type="hidden" name="view" value={view} />
        {sp.search ? <input type="hidden" name="search" value={sp.search} /> : null}
        <label className="text-sm">
          <span className="mb-1 block text-xs text-[color:var(--color-muted-foreground)]">Account</span>
          <select name="account" defaultValue={sp.account ?? ""} className="h-9 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm">
            <option value="">All accounts</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({platformShort(a.platform)})
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs text-[color:var(--color-muted-foreground)]">Campaign</span>
          <select name="campaign" defaultValue={sp.campaign ?? ""} className="h-9 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm">
            <option value="">All campaigns</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="h-9 rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 text-sm">
          Filter
        </button>
      </form>
        <div className="ml-auto">
          <SearchField placeholder="Name or text" defaultValue={sp.search ?? ""} preserve={{ view, account: sp.account, campaign: sp.campaign }} />
        </div>
      </div>
      {posts.length === 0 ? (
        <EmptyState>{t.empty}</EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Post</Th>
              <Th>Accounts</Th>
              <Th>Status</Th>
              <Th>When ({tz})</Th>
              <Th>Campaign</Th>
            </tr>
          </thead>
          <tbody>
            {posts.map((p) => (
              <tr key={p.id}>
                <Td className="max-w-md">
                  <Link href={`/social/posts/${p.id}`} className="font-medium hover:underline">
                    {p.title ?? (p.excerpt || "Untitled")}
                  </Link>
                  {p.title && p.excerpt ? <p className="truncate text-xs text-[color:var(--color-muted-foreground)]">{p.excerpt}</p> : null}
                  <p className="text-xs text-[color:var(--color-subtle-foreground)]">
                    by {p.createdByUsername}
                    {p.aiAssisted ? " · AI-assisted" : ""}
                    {p.reviewerUsername && p.status === "IN_REVIEW" ? ` · reviewer ${p.reviewerUsername}` : ""}
                  </p>
                </Td>
                <Td className="text-xs">{p.accounts.map((a) => `${platformShort(a.platform)} · ${a.name}`).join(", ") || "—"}</Td>
                <Td>
                  <PostStatusBadge status={p.status} />
                </Td>
                <Td className="tabular text-xs">{formatInZone(p.when, tz)}</Td>
                <Td className="text-xs">{p.campaign?.name ?? "—"}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
