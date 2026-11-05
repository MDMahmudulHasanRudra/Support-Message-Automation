import { notFound } from "next/navigation";
import { FAILED_REPLY_CATEGORY_LABELS, FAILED_REPLY_MAX_MANUAL_RETRIES, FAILED_REPLY_STATE_LABELS, type FailedReplySource } from "@support-automation/shared";
import { requireAccess } from "@/server/authorize";
import { hasPermission } from "@/server/permissions";
import { disabledFeaturesFor } from "@/server/projectFeatures";
import { activeProjectId } from "@/server/projectContext";
import Link from "@/components/ProjectLink";
import { Alert, Badge, Card, PageHeader } from "@/components/ui";
import { formatDateTime } from "@/lib/date";
import { conversationHref, failedReplyHistory, getFailedReply, originalMessageFor, retryDecisionFor } from "@/server/failedReplies";
import { FailedReplyActions } from "./FailedReplyActions";

const ACTION_LABEL: Record<string, string> = { RETRY: "Sent again", RESOLVE: "Marked resolved", CLOSE: "Closed", REOPEN: "Reopened" };

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-3 py-1.5 text-[13px]">
      <dt className="text-[color:var(--color-muted-foreground)]">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

export default async function FailedReplyPage({ params }: { params: Promise<{ source: string; id: string }> }) {
  const session = await requireAccess("messages.view");
  const { source: rawSource, id } = await params;
  const source: FailedReplySource | null = rawSource === "whatsapp" ? "WHATSAPP" : rawSource === "channel" ? "CHANNEL" : null;
  if (!source) notFound();
  const includeChannels = !(await disabledFeaturesFor(await activeProjectId())).has("OMNICHANNEL");
  const row = await getFailedReply(source, id, includeChannels);
  if (!row) notFound();

  const canAct = source === "WHATSAPP" ? await hasPermission(session, "messages.reply") : await hasPermission(session, "conversations.reply");
  const [history, original, retry] = await Promise.all([failedReplyHistory(source, id), originalMessageFor(row.relatedMessageId), retryDecisionFor(row)]);
  const chatHref = conversationHref(row);
  const uncertain = row.category === "DELIVERY_UNCERTAIN";

  return (
    <div className="max-w-4xl">
      <PageHeader
        title={`Reply to ${row.chatName}`}
        description={`${FAILED_REPLY_CATEGORY_LABELS[row.category]} · ${FAILED_REPLY_STATE_LABELS[row.state]}`}
      />
      <p className="-mt-2 mb-4 text-[12px]">
        <Link href="/messages/failed-replies" className="text-[color:var(--color-accent)] hover:underline">
          ← All failed replies
        </Link>
      </p>

      {uncertain && row.state === "FAILED" ? (
        <div className="mb-4">
          <Alert tone="warning" title="The customer may already have this message">
            The send started and never answered, so it was not sent again automatically.{" "}
            {retry.echoAt
              ? `A matching message from this number appears in the chat at ${formatDateTime(retry.echoAt)}, so it most likely arrived — mark it resolved.`
              : "Open the chat and look for it before you retry."}
          </Alert>
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-[1fr_18rem]">
        <div className="space-y-4">
          <Card>
            <h2 className="mb-2 text-[14px] font-semibold">The reply</h2>
            <p className="whitespace-pre-wrap rounded-[var(--radius-sm)] bg-[var(--color-neutral-bg)] p-3 text-[13px]">{row.text || "—"}</p>
            <dl className="mt-3">
              <Row label="Channel">
                {row.channelType === "WHATSAPP" ? "WhatsApp" : row.channelType} · {row.accountLabel}
                {row.connectionStatus ? <span className="text-[color:var(--color-muted-foreground)]"> ({row.connectionStatus.toLowerCase().replace(/_/g, " ")})</span> : null}
              </Row>
              <Row label="Queued">{formatDateTime(new Date(row.createdAt))}</Row>
              <Row label="Sent by">{row.actionType === "AUTO_REPLY" ? "Automatic reply (rule or AI)" : "A person"}</Row>
              <Row label="Status">
                <Badge color={row.state === "FAILED" ? "red" : row.state === "RETRYING" ? "blue" : row.state === "RESOLVED" ? "green" : "gray"}>{FAILED_REPLY_STATE_LABELS[row.state]}</Badge>
                <span className="ml-2 text-[color:var(--color-muted-foreground)]">({row.status.toLowerCase().replace(/_/g, " ")})</span>
              </Row>
              <Row label="What happened">
                <strong className="font-medium">{FAILED_REPLY_CATEGORY_LABELS[row.category]}</strong>
                {row.failureReason ? <div className="mt-0.5 text-[color:var(--color-muted-foreground)]">{row.failureReason}</div> : null}
              </Row>
              <Row label="Attempts">
                {row.attempts} automatic{row.lastAttemptAt ? `, last ${formatDateTime(new Date(row.lastAttemptAt))}` : ""}; {row.manualRetryCount} of {FAILED_REPLY_MAX_MANUAL_RETRIES} manual retries used
              </Row>
              {row.resolution ? (
                <Row label={row.resolution === "CLOSED" ? "Closed" : "Resolved"}>
                  {row.resolvedAt ? formatDateTime(new Date(row.resolvedAt)) : ""}
                  {row.resolutionNote ? <div className="text-[color:var(--color-muted-foreground)]">“{row.resolutionNote}”</div> : null}
                </Row>
              ) : null}
            </dl>
          </Card>

          {original ? (
            <Card>
              <h2 className="mb-2 text-[14px] font-semibold">What the customer wrote</h2>
              <p className="whitespace-pre-wrap text-[13px]">{original.body || "—"}</p>
              <p className="mt-1 text-[11px] text-[color:var(--color-muted-foreground)]">
                {original.senderName ?? "Customer"} · {formatDateTime(original.timestampWa)} ·{" "}
                <Link href={`/messages/${original.id}`} className="underline">
                  Message details
                </Link>
              </p>
            </Card>
          ) : null}

          <Card>
            <h2 className="mb-2 text-[14px] font-semibold">History</h2>
            {history.length === 0 ? (
              <p className="text-[13px] text-[color:var(--color-muted-foreground)]">Nobody has acted on this reply yet.</p>
            ) : (
              <ol className="space-y-2">
                {history.map((h) => (
                  <li key={h.id} className="text-[13px]">
                    <span className="font-medium">{ACTION_LABEL[h.action] ?? h.action}</span> by {h.actorUsername ?? "a removed user"} · {formatDateTime(h.createdAt)}
                    <div className="text-[11px] text-[color:var(--color-muted-foreground)]">
                      Was {h.fromStatus.toLowerCase().replace(/_/g, " ")}
                      {h.confirmedUncertain ? " · confirmed the chat was checked first" : ""}
                      {h.failureReason ? ` · ${h.failureReason}` : ""}
                    </div>
                    {h.note ? <div className="text-[12px]">“{h.note}”</div> : null}
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>

        <div className="space-y-3">
          {chatHref ? (
            <Link href={chatHref} className="block rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2 text-[13px] font-medium text-[color:var(--color-accent)] hover:bg-[var(--color-neutral-bg)]">
              Open the conversation →
            </Link>
          ) : null}
          {canAct ? (
            <FailedReplyActions
              item={{ source: row.source, id: row.id }}
              state={row.state}
              uncertain={uncertain}
              retryAllowed={retry.decision.ok || retry.decision.needsConfirmation === true}
              retryReason={retry.decision.ok ? null : retry.decision.reason}
              reopenable={row.resolution !== null}
            />
          ) : (
            <p className="text-[12px] text-[color:var(--color-muted-foreground)]">You can see this reply but not act on it.</p>
          )}
        </div>
      </div>
    </div>
  );
}
