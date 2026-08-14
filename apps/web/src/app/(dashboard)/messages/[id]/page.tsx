import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { Badge, type BadgeColor, Card, PageHeader, SectionHeader } from "@/components/ui";
import type { ReactNode } from "react";

interface DecisionTraceEntry {
  ruleId: string | null;
  ruleName: string;
  priority: number | null;
  matched: boolean;
  applied: boolean;
  reason: string;
}

export default async function MessageDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await params;

  const message = await prisma.message.findUnique({
    where: { id },
    include: {
      account: { select: { label: true } },
      group: { select: { name: true, whatsappGroupId: true } },
      executions: {
        orderBy: { matchedAt: "desc" },
        include: { rule: { select: { name: true, type: true } } },
      },
      outboundReplies: { orderBy: { createdAt: "desc" } },
      notifications: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!message) notFound();

  const execution = message.executions[0] ?? null;
  const trace = (execution?.reasonTrace as unknown as DecisionTraceEntry[] | null) ?? [];
  const actionsExecuted =
    (execution?.actionsExecuted as unknown as Array<{ type: string; executed: boolean; reason: string }> | null) ?? [];

  return (
    <div>
      <PageHeader title="Message Detail" description={message.id} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <Card>
            <SectionHeader title="Message" />
            <dl className="grid grid-cols-1 gap-x-4 gap-y-4 text-sm sm:grid-cols-2">
              <Field label="Database Message ID" value={<Mono>{message.id}</Mono>} />
              <Field label="WhatsApp Message ID" value={<Mono>{message.whatsappMessageId}</Mono>} />
              <Field label="Account" value={message.account.label} />
              <Field label="Group" value={message.group?.name ?? "—"} />
              <Field label="Group WhatsApp ID" value={<Mono>{message.group?.whatsappGroupId ?? "—"}</Mono>} />
              <Field label="Sender" value={message.senderName ?? "—"} />
              <Field
                label="Sender Phone/Identifier"
                value={
                  <>
                    <Mono>{message.senderPhone}</Mono>
                    {message.isFromTeamMember ? (
                      <span className="ml-1.5">
                        <Badge color="blue">Team Member</Badge>
                      </span>
                    ) : null}
                  </>
                }
              />
              <Field label="Direction" value={message.direction} />
              <Field label="WhatsApp Timestamp" value={message.timestampWa.toLocaleString()} />
              <Field label="Received At" value={message.receivedAt.toLocaleString()} />
              <Field
                label="Processing Status"
                value={
                  <Badge color={message.processingStatus === "IGNORED" ? "gray" : "green"} dot>
                    {message.processingStatus}
                  </Badge>
                }
              />
            </dl>
            <div className="mt-4">
              <p className="mb-1.5 text-xs font-medium text-[color:var(--color-muted-foreground)]">Message Body</p>
              <p className="whitespace-pre-wrap rounded-[var(--radius-md)] border border-[var(--color-border)] p-3 text-sm text-[color:var(--color-foreground)] shadow-[var(--shadow-xs)]">
                {message.body}
              </p>
            </div>
          </Card>

          <Card>
            <SectionHeader title="Rule Evaluation & Decision" />
            {execution ? (
              <>
                <dl className="mb-4 grid grid-cols-1 gap-x-4 gap-y-4 text-sm sm:grid-cols-3">
                  <Field label="Decision" value={<Badge color={decisionColor(execution.decision)}>{execution.decision}</Badge>} />
                  <Field label="Matched Rule" value={execution.rule?.name ?? "None (NO_MATCH)"} />
                  <Field label="Evaluated At" value={execution.matchedAt.toLocaleString()} />
                </dl>
                <p className="mb-1.5 text-xs font-medium text-[color:var(--color-muted-foreground)]">
                  Actions Executed
                </p>
                <ul className="mb-4 space-y-1 text-sm text-[color:var(--color-foreground)]">
                  {actionsExecuted.length === 0 ? <li className="text-[color:var(--color-muted-foreground)]">None</li> : null}
                  {actionsExecuted.map((a, i) => (
                    <li key={i}>
                      <span className="font-medium">{a.type}</span> —{" "}
                      {a.executed ? "executed" : "not executed"}: {a.reason}
                    </li>
                  ))}
                </ul>
                <p className="mb-1.5 text-xs font-medium text-[color:var(--color-muted-foreground)]">
                  Full Rule Trace
                </p>
                <ul className="space-y-1.5 text-sm">
                  {trace.map((t, i) => (
                    <li
                      key={i}
                      className={
                        t.applied
                          ? "rounded-[var(--radius-md)] border border-[var(--color-success-border)] bg-[var(--color-success-bg)] p-2.5 font-medium text-[color:var(--color-success-fg)] shadow-[var(--shadow-xs)]"
                          : "p-2.5 text-[color:var(--color-muted-foreground)]"
                      }
                    >
                      {t.ruleName} (priority {t.priority ?? "—"}) — {t.matched ? "matched" : "not matched"}
                      {t.applied ? " (applied)" : ""}: {t.reason}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-sm text-[color:var(--color-muted-foreground)]">
                No rule evaluation recorded for this message.
              </p>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <SectionHeader title="Auto-Reply" />
            {message.outboundReplies.length === 0 ? (
              <p className="text-sm text-[color:var(--color-muted-foreground)]">
                No outbound message was created for this incoming message.
              </p>
            ) : (
              <ul className="space-y-2 text-sm">
                {message.outboundReplies.map((r) => (
                  <li
                    key={r.id}
                    className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-3 shadow-[var(--shadow-xs)]"
                  >
                    <div className="mb-1.5 flex items-center gap-2">
                      <Badge color={outboundStatusColor(r.status)} dot>
                        {r.status}
                      </Badge>
                      <span className="text-xs text-[color:var(--color-muted-foreground)]">{r.actionType}</span>
                    </div>
                    <p className="whitespace-pre-wrap text-[color:var(--color-foreground)]">{r.body}</p>
                    <p className="mt-1.5 text-xs text-[color:var(--color-muted-foreground)]">
                      Attempts: {r.attemptCount} · Sent: {r.sentAt?.toLocaleString() ?? "—"}
                      {r.failureReason ? ` · Failure: ${r.failureReason}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <SectionHeader title="Notifications" />
            {message.notifications.length === 0 ? (
              <p className="text-sm text-[color:var(--color-muted-foreground)]">
                No notification was triggered for this message.
              </p>
            ) : (
              <ul className="space-y-2 text-sm">
                {message.notifications.map((n) => (
                  <li
                    key={n.id}
                    className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-3 shadow-[var(--shadow-xs)]"
                  >
                    <div className="mb-1.5 flex items-center gap-2">
                      <Badge color={outboundStatusColor(n.status)} dot>
                        {n.status}
                      </Badge>
                      <span className="text-xs text-[color:var(--color-muted-foreground)]">
                        {n.type} → {n.destination}
                      </span>
                    </div>
                    <p className="text-xs text-[color:var(--color-muted-foreground)]">
                      Attempts: {n.attemptCount} · Sent: {n.sentAt?.toLocaleString() ?? "—"}
                      {n.failureReason ? ` · Failure: ${n.failureReason}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <p className="mt-4 text-xs">
        <Link
          href="/messages"
          className="inline-flex items-center gap-1 text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)] hover:underline"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          Back to All Messages
        </Link>
      </p>
    </div>
  );
}

function decisionColor(decision: string): BadgeColor {
  if (decision === "SUPPORT_REQUIRED") return "red";
  if (decision === "AUTO_REPLY" || decision === "ACTIONED") return "green";
  if (decision === "IGNORE" || decision === "STOPPED") return "gray";
  return "yellow"; // NO_MATCH
}

function outboundStatusColor(status: string): BadgeColor {
  if (status === "SENT") return "green";
  if (status === "FAILED") return "red";
  return "yellow";
}

function Mono({ children }: { children: ReactNode }) {
  return <span className="font-[family-name:var(--font-mono)] text-xs">{children}</span>;
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-[color:var(--color-muted-foreground)]">{label}</dt>
      <dd className="mt-0.5 text-[color:var(--color-foreground)]">{value}</dd>
    </div>
  );
}
