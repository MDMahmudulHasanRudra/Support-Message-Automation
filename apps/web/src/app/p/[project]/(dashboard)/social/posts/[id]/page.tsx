import { notFound } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { platformHas, SOCIAL_EDITABLE_STATUSES, utcToZonedLocal, type SocialMetricValue } from "@support-automation/shared";
import Link from "@/components/ProjectLink";
import { Alert, Card, PageHeader, SectionHeader, Table, Td, Th } from "@/components/ui";
import { pageAccess } from "@/server/authorize";
import { hasPermission } from "@/server/permissions";
import { getSocialPost } from "@/server/social/posts";
import { PostComposer } from "../../PostComposer";
import { loadComposerChoices } from "../../composerData";
import { formatInZone, platformLabel, PostStatusBadge, TargetStatusBadge } from "../../socialUi";
import { CommentBox, PostActions, TargetActions } from "./PostControls";

export const metadata = { title: "Social post" };

const EVENT_LABELS: Record<string, string> = {
  CREATED: "created it",
  EDITED: "edited it",
  SUBMITTED: "sent it for approval",
  APPROVED: "approved it",
  REJECTED: "sent it back",
  SCHEDULED: "scheduled it",
  RESCHEDULED: "moved it",
  CANCELLED: "cancelled",
  PUBLISHED: "published",
  FAILED: "failed",
  DEFERRED: "will retry",
  UNKNOWN: "outcome unknown",
  REQUEUED: "requeued (nothing had been sent)",
  MATCHED: "found the publication on the account",
  RETRY: "retried",
  SEND_AGAIN: "sent again after checking the account",
  MARKED: "recorded the outcome",
  DELETED_FROM_PLATFORM: "deleted it from the platform",
  DUPLICATED: "duplicated it",
  STATUS: "status changed",
  AI: "used AI",
};

export default async function SocialPostPage({ params }: { params: Promise<{ id: string }> }) {
  const { session, canManage: canEdit } = await pageAccess("social.view", "social.edit", "SOCIAL_STUDIO");
  const { id } = await params;
  const loaded = await getSocialPost(id);
  if (!loaded) notFound();
  const { post, media, approvalMatches, problems } = loaded;
  const [canApprove, canPublish] = await Promise.all([hasPermission(session, "social.approve"), hasPermission(session, "social.publish")]);
  const editable = canEdit && (SOCIAL_EDITABLE_STATUSES as readonly string[]).includes(post.status);
  const choices = editable ? await loadComposerChoices() : null;
  const tz = post.timezone;
  const comments = post.events.filter((e) => e.kind === "COMMENT");
  const history = post.events.filter((e) => e.kind !== "COMMENT");

  return (
    <div>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            {post.title ?? "Post"} <PostStatusBadge status={post.status} />
          </span>
        }
        description={`Created by ${post.createdByUsername}${post.campaign ? ` · campaign ${post.campaign.name}` : ""}${post.aiAssisted ? " · AI-assisted text (still needs a person's approval)" : ""}. Times in ${tz}.`}
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <div className="min-w-0 space-y-6">
          {post.lastError ? <Alert tone="warning" title={post.lastError} /> : null}
          {problems.length && ["DRAFT", "IN_REVIEW", "APPROVED"].includes(post.status) ? (
            <Alert tone="warning" title="Fix these before it can be approved:">
              <ul className="list-disc pl-5 text-sm">
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </Alert>
          ) : null}
          {post.status === "APPROVED" && !approvalMatches ? <Alert tone="warning" title="The post changed after it was approved; it must be approved again." /> : null}

          <section>
            <SectionHeader title="Publishing" description="Each account is published, retried and checked on its own." />
            <Table>
              <thead>
                <tr>
                  <Th>Account</Th>
                  <Th>Status</Th>
                  <Th>Time</Th>
                  <Th>Details</Th>
                </tr>
              </thead>
              <tbody>
                {post.targets.map((t) => {
                  const metrics = Array.isArray(t.metrics) ? (t.metrics as unknown as SocialMetricValue[]) : [];
                  return (
                    <tr key={t.id}>
                      <Td>
                        <p className="font-medium">{t.account.name}</p>
                        <p className="text-xs text-[color:var(--color-muted-foreground)]">
                          {platformLabel(t.account.platform)}
                          {t.contentOverride ? " · own text" : ""}
                        </p>
                      </Td>
                      <Td>
                        <TargetStatusBadge status={t.status} />
                        {t.attempts > 0 ? <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">{t.attempts} attempt(s)</p> : null}
                      </Td>
                      <Td className="tabular text-xs">{formatInZone(t.publishedAt ?? t.dueAt, tz)}</Td>
                      <Td className="space-y-1 text-xs">
                        {t.permalink ? (
                          <a href={t.permalink} target="_blank" rel="noopener noreferrer" className="link inline-flex items-center gap-1">
                            View post <ExternalLink className="size-3" aria-hidden />
                          </a>
                        ) : null}
                        {t.error ? <p className="text-[color:var(--color-muted-foreground)]">{t.error}</p> : null}
                        {metrics.length ? (
                          <p className="tabular">
                            {metrics.map((m) => `${m.label}: ${m.value.toLocaleString("en-US")}`).join(" · ")}
                            {t.metricsAt ? <span className="text-[color:var(--color-subtle-foreground)]"> (as of {formatInZone(t.metricsAt, tz)})</span> : null}
                          </p>
                        ) : null}
                        <TargetActions targetId={t.id} status={t.status} canPublish={canPublish} canDelete={platformHas(t.account.platform, "DELETE")} hasMetrics={platformHas(t.account.platform, "POST_METRICS")} />
                        {t.publishAttempts.length ? (
                          <details>
                            <summary className="cursor-pointer text-[color:var(--color-subtle-foreground)]">Attempts</summary>
                            <ul className="mt-1 space-y-0.5">
                              {t.publishAttempts.map((a) => (
                                <li key={a.id}>
                                  #{a.attemptNo} {formatInZone(a.startedAt, tz)} — {a.outcome ?? "running"}
                                  {a.requestSentAt ? "" : " (nothing sent)"}
                                  {a.message ? `: ${a.message}` : ""}
                                </li>
                              ))}
                            </ul>
                          </details>
                        ) : null}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </section>

          {editable && choices ? (
            <section>
              <SectionHeader title="Edit" description="Saving returns the post to Draft; it has to be approved again." />
              <PostComposer
                initial={{
                  id: post.id,
                  revision: post.revision,
                  title: post.title ?? "",
                  content: post.content,
                  accountIds: post.targets.map((t) => t.accountId),
                  variants: Object.fromEntries(post.targets.filter((t) => t.contentOverride).map((t) => [t.accountId, t.contentOverride!])),
                  settings: Object.fromEntries(post.targets.filter((t) => t.settings && typeof t.settings === "object").map((t) => [t.accountId, t.settings as Record<string, unknown>])),
                  mediaIds: post.mediaIds,
                  campaignId: post.campaignId ?? "",
                  publishMode: post.publishMode === "NOW" ? "NOW" : "SCHEDULE",
                  scheduledLocal: post.scheduledAt ? utcToZonedLocal(post.scheduledAt, tz) : "",
                  timezone: tz,
                  aiAssisted: post.aiAssisted,
                }}
                {...choices}
              />
            </section>
          ) : (
            <section>
              <SectionHeader title="Content" />
              <Card className="space-y-3 p-4 text-sm">
                <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{post.content || <span className="italic text-[color:var(--color-muted-foreground)]">No main text</span>}</p>
                {media.length ? <p className="text-xs text-[color:var(--color-muted-foreground)]">Attached: {media.map((m) => m.name + (m.deletedAt ? " (deleted)" : "")).join(", ")}</p> : null}
              </Card>
            </section>
          )}
        </div>

        <aside className="min-w-0 space-y-6">
          <Card className="space-y-2 p-4 text-sm">
            <p>
              <span className="text-[color:var(--color-muted-foreground)]">Planned:</span> {post.scheduledAt ? formatInZone(post.scheduledAt, tz) : post.publishMode === "NOW" ? "as soon as it is scheduled" : "no time yet"}
            </p>
            {post.submittedByUsername ? (
              <p>
                <span className="text-[color:var(--color-muted-foreground)]">Sent for approval by</span> {post.submittedByUsername}
                {post.reviewerUsername ? `, asking ${post.reviewerUsername}` : ""}
              </p>
            ) : null}
            {post.approvedByUsername ? (
              <p>
                <span className="text-[color:var(--color-muted-foreground)]">Approved by</span> {post.approvedByUsername} · {formatInZone(post.approvedAt, tz)}
              </p>
            ) : null}
            {post.reviewNote ? <p className="rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] p-2">“{post.reviewNote}”</p> : null}
            {post.scheduledByUsername ? (
              <p>
                <span className="text-[color:var(--color-muted-foreground)]">Scheduled by</span> {post.scheduledByUsername}
              </p>
            ) : null}
          </Card>

          <PostActions
            id={post.id}
            status={post.status}
            revision={post.revision}
            can={{ edit: canEdit, approve: canApprove, publish: canPublish }}
            scheduledLocal={post.scheduledAt ? utcToZonedLocal(post.scheduledAt, tz) : ""}
            timezone={tz}
            publishMode={post.publishMode === "NOW" ? "NOW" : "SCHEDULE"}
          />

          <section>
            <SectionHeader title="Comments" />
            <ul className="mb-3 space-y-2">
              {comments.length === 0 ? <li className="text-sm text-[color:var(--color-muted-foreground)]">No comments yet.</li> : null}
              {comments.map((c) => (
                <li key={c.id} className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-2 text-sm">
                  <p className="text-xs text-[color:var(--color-muted-foreground)]">
                    {c.actorUsername} · {formatInZone(c.createdAt, tz)}
                  </p>
                  <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{String((c.detail as { text?: string } | null)?.text ?? "")}</p>
                </li>
              ))}
            </ul>
            {canEdit || canApprove ? <CommentBox postId={post.id} /> : null}
          </section>

          <section>
            <SectionHeader title="History" />
            <ol className="space-y-1 text-xs">
              {history.map((e) => (
                <li key={e.id}>
                  <span className="tabular text-[color:var(--color-subtle-foreground)]">{formatInZone(e.createdAt, tz)}</span> — {e.actorUsername ?? "Social Studio"} {EVENT_LABELS[e.kind] ?? e.kind.toLowerCase()}
                  {typeof (e.detail as { account?: string } | null)?.account === "string" ? ` (${(e.detail as { account: string }).account})` : ""}
                </li>
              ))}
            </ol>
            <p className="mt-2 text-xs">
              <Link href="/social/posts?view=all" className="link">
                Back to all posts
              </Link>
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}
