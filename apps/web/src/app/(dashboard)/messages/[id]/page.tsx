import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { Badge, Card, PageHeader } from "@/components/ui";

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
  const actionsExecuted = (execution?.actionsExecuted as unknown as Array<{ type: string; executed: boolean; reason: string }> | null) ?? [];

  return (
    <div>
      <PageHeader title="Message Detail" description={message.id} />
      <p className="mb-4 text-sm">
        <Link href="/messages" className="underline">
          ← Back to All Messages
        </Link>
      </p>

      <Card className="mb-4">
        <h2 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Message</h2>
        <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
          <Field label="Database Message ID" value={message.id} />
          <Field label="WhatsApp Message ID" value={message.whatsappMessageId} />
          <Field label="Account" value={message.account.label} />
          <Field label="Group" value={message.group?.name ?? "—"} />
          <Field label="Group WhatsApp ID" value={message.group?.whatsappGroupId ?? "—"} />
          <Field label="Sender" value={message.senderName ?? "—"} />
          <Field
            label="Sender Phone/Identifier"
            value={
              <>
                {message.senderPhone}
                {message.isFromTeamMember ? (
                  <span className="ml-1">
                    <Badge color="blue">Team Member</Badge>
                  </span>
                ) : null}
              </>
            }
          />
          <Field label="Direction" value={message.direction} />
          <Field label="WhatsApp Timestamp" value={message.timestampWa.toLocaleString()} />
          <Field label="Received At" value={message.receivedAt.toLocaleString()} />
          <Field label="Processing Status" value={<Badge color={message.processingStatus === "IGNORED" ? "gray" : "green"}>{message.processingStatus}</Badge>} />
        </dl>
        <div className="mt-3">
          <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Message Body</p>
          <p className="whitespace-pre-wrap rounded-md border border-zinc-200 p-3 text-sm dark:border-zinc-800">{message.body}</p>
        </div>
      </Card>

      <Card className="mb-4">
        <h2 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Rule Evaluation &amp; Decision</h2>
        {execution ? (
          <>
            <dl className="mb-3 grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
              <Field label="Decision" value={<Badge color="blue">{execution.decision}</Badge>} />
              <Field label="Matched Rule" value={execution.rule?.name ?? "None (NO_MATCH)"} />
              <Field label="Evaluated At" value={execution.matchedAt.toLocaleString()} />
            </dl>
            <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Actions Executed</p>
            <ul className="mb-3 list-inside list-disc text-sm">
              {actionsExecuted.length === 0 ? <li>None</li> : null}
              {actionsExecuted.map((a, i) => (
                <li key={i}>
                  <span className="font-medium">{a.type}</span> — {a.executed ? "executed" : "not executed"}: {a.reason}
                </li>
              ))}
            </ul>
            <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Full Rule Trace</p>
            <ul className="space-y-1 text-sm text-zinc-600 dark:text-zinc-400">
              {trace.map((t, i) => (
                <li key={i} className={t.applied ? "font-medium text-zinc-900 dark:text-zinc-100" : ""}>
                  {t.ruleName} (priority {t.priority ?? "—"}) — {t.matched ? "matched" : "not matched"}
                  {t.applied ? " (applied)" : ""}: {t.reason}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No rule evaluation recorded for this message.</p>
        )}
      </Card>

      <Card className="mb-4">
        <h2 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Auto-Reply</h2>
        {message.outboundReplies.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No outbound message was created for this incoming message.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {message.outboundReplies.map((r) => (
              <li key={r.id} className="rounded-md border border-zinc-200 p-2 dark:border-zinc-800">
                <div className="mb-1 flex items-center gap-2">
                  <Badge color={r.status === "SENT" ? "green" : r.status === "FAILED" ? "red" : "yellow"}>{r.status}</Badge>
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">{r.actionType}</span>
                </div>
                <p className="whitespace-pre-wrap">{r.body}</p>
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                  Attempts: {r.attemptCount} · Sent: {r.sentAt?.toLocaleString() ?? "—"}
                  {r.failureReason ? ` · Failure: ${r.failureReason}` : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Notifications</h2>
        {message.notifications.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No notification was triggered for this message.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {message.notifications.map((n) => (
              <li key={n.id} className="rounded-md border border-zinc-200 p-2 dark:border-zinc-800">
                <div className="mb-1 flex items-center gap-2">
                  <Badge color={n.status === "SENT" ? "green" : n.status === "FAILED" ? "red" : "yellow"}>{n.status}</Badge>
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">
                    {n.type} → {n.destination}
                  </span>
                </div>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  Attempts: {n.attemptCount} · Sent: {n.sentAt?.toLocaleString() ?? "—"}
                  {n.failureReason ? ` · Failure: ${n.failureReason}` : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
