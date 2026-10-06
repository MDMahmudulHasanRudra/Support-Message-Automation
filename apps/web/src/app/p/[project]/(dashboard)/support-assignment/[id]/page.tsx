import type { ReactNode } from "react";
import type { SupportAssignmentEventType } from "@prisma/client";
import { notFound } from "next/navigation";
import { formatResponseDuration } from "@support-automation/shared";
import { MessageSquareText } from "lucide-react";
import Link from "@/components/ProjectLink";
import { Badge, Card, PageHeader, SectionHeader } from "@/components/ui";
import { formatDateTime } from "@/lib/date";
import { requireAccess } from "@/server/authorize";
import { hasPermission } from "@/server/permissions";
import { getAssignableMembers, getAssignmentDetail, getSupportAssignmentSettings } from "@/server/supportAssignment";
import { AssignmentBadge } from "../AssignmentBadge";
import { CaseActions } from "./CaseActions";

const EVENT_LABELS: Record<SupportAssignmentEventType, string> = {
  OPENED: "Customer message received",
  IGNORED: "Filtered out by the ignore rules",
  QUALIFIED: "The customer wrote something that is support work",
  ASSIGNED: "Assigned",
  REASSIGNED: "Reassigned",
  NOTIFIED: "WhatsApp notification queued",
  NOTIFY_SKIPPED: "WhatsApp notification not sent",
  OVERDUE: "SLA exceeded — overdue",
  ESCALATED: "Escalated",
  COMPLETED: "Completed",
  ANSWERED_BY_OTHER: "Answered by someone else",
  CANCELLED: "Cancelled",
};

const DELIVERY: Record<string, { label: string; color: "green" | "red" | "yellow" }> = {
  SENT: { label: "Delivered", color: "green" },
  FAILED: { label: "Failed", color: "red" },
  PENDING: { label: "Waiting to send", color: "yellow" },
  RETRYING: { label: "Retrying", color: "yellow" },
};

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-[0.04em] text-[color:var(--color-muted-foreground)]">{label}</dt>
      <dd className="mt-0.5 text-[13px]">{children ?? "—"}</dd>
    </div>
  );
}

/** One case: the customer's message, who has it, its deadline, and its full history. */
export default async function SupportCasePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireAccess("support_assignment.view");
  const { id } = await params;
  const row = await getAssignmentDetail(id);
  if (!row) notFound();
  const open = row.closedAt === null && (row.status === "UNASSIGNED" || row.status === "ASSIGNED" || row.status === "OVERDUE");
  const [canAssign, settings] = await Promise.all([hasPermission(session, "support_assignment.assign"), getSupportAssignmentSettings()]);
  const members = canAssign && open && settings?.enabled ? await getAssignableMembers(settings.assignableTeamIds) : null;
  const customer = row.firstMessage ? row.firstMessage.senderName || row.firstMessage.senderPhone : null;

  return (
    <div>
      <PageHeader
        title={row.group.name}
        description={`Support case · ${row.account.label}`}
        actions={members ? <CaseActions id={row.id} unassigned={row.status === "UNASSIGNED"} members={members} /> : null}
      />

      <Card className="mb-5">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <AssignmentBadge status={row.status} />
          {row.escalationLevel > 0 ? <Badge color="red">Escalated</Badge> : null}
          <Link href={`/chat/${row.groupId}`} className="ml-auto inline-flex items-center gap-1 text-[13px] text-[color:var(--color-accent)] hover:underline">
            <MessageSquareText className="size-4" aria-hidden /> Open the conversation
          </Link>
        </div>
        <blockquote className="mb-4 rounded-[var(--radius-md)] border-l-2 border-[var(--color-border-strong)] bg-[var(--color-neutral-bg)] px-4 py-3 text-[14px] leading-relaxed">
          {row.firstMessage?.body || (row.status === "IGNORED" ? `${row.ignoredMessageCount} message(s), all filtered out` : "(attachment, no text)")}
          <footer className="mt-1 text-[12px] text-[color:var(--color-muted-foreground)]">
            {customer ?? "Unknown sender"}
            {row.firstMessageAt ? ` · ${formatDateTime(row.firstMessageAt)}` : ""}
          </footer>
        </blockquote>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          <Fact label="Assigned to">{row.assignedMember?.name}</Fact>
          <Fact label="Assigned">
            {row.assignedAt ? `${formatDateTime(row.assignedAt)}${row.assignedBy ? ` by ${row.assignedBy.name || row.assignedBy.username}` : ""}` : null}
          </Fact>
          <Fact label="SLA">{row.slaMinutes ? `${row.slaMinutes} minute(s)` : null}</Fact>
          <Fact label="Due">{row.dueAt ? formatDateTime(row.dueAt) : null}</Fact>
          <Fact label="Answered by">{row.responderMember?.name}</Fact>
          <Fact label="Answered">{row.closedAt && row.responderMember ? formatDateTime(row.closedAt) : null}</Fact>
          <Fact label="Response time">{row.responseSeconds !== null ? formatResponseDuration(row.responseSeconds) : null}</Fact>
          <Fact label="Filtered messages">{row.ignoredMessageCount}</Fact>
        </dl>
        {row.completionMessage ? (
          <p className="mt-4 text-[13px] text-[color:var(--color-muted-foreground)]">
            Reply: <span className="text-[color:var(--color-foreground)]">&ldquo;{row.completionMessage.body || "(attachment)"}&rdquo;</span>
          </p>
        ) : null}
        {row.closeReason ? <p className="mt-2 text-[13px] text-[color:var(--color-muted-foreground)]">{row.closeReason}</p> : null}
      </Card>

      <Card>
        <SectionHeader title="History" description="Every step of this case, oldest first, with the delivery state of each WhatsApp notification." />
        <ol className="relative ml-2 border-l border-[var(--color-border)]">
          {row.events.map((e) => {
            const delivery = e.notification ? DELIVERY[e.notification.status] : null;
            return (
              <li key={e.id} className="mb-4 ml-4 last:mb-0">
                <span aria-hidden className="absolute -left-[5px] mt-1.5 size-2.5 rounded-full border-2 border-[var(--color-surface)] bg-[var(--color-border-strong)]" />
                <div className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
                  <time className="tabular text-[12px] text-[color:var(--color-muted-foreground)]">{formatDateTime(e.at)}</time>
                  <span className="font-medium">{EVENT_LABELS[e.type]}</span>
                  {e.recipient ? <span className="text-[color:var(--color-muted-foreground)]">→ {e.recipient}</span> : null}
                  {!e.recipient && e.member ? <span className="text-[color:var(--color-muted-foreground)]">{e.member.name}</span> : null}
                  {delivery ? <Badge color={delivery.color}>{delivery.label}</Badge> : null}
                </div>
                {e.detail ? <p className="mt-0.5 text-[12px] text-[color:var(--color-muted-foreground)]">{e.detail}</p> : null}
                {e.notification?.failureReason ? <p className="mt-0.5 text-[12px] text-[color:var(--color-danger-fg)]">{e.notification.failureReason}</p> : null}
                {e.actorUser ? <p className="mt-0.5 text-[11px] text-[color:var(--color-muted-foreground)]">by {e.actorUser.name || e.actorUser.username}</p> : null}
              </li>
            );
          })}
        </ol>
      </Card>
    </div>
  );
}
