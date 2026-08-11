import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { Alert, Badge, type BadgeColor, Card, PageHeader, ProgressBar, StatTile, Table, Td, Th } from "@/components/ui";
import { AutoRefresh } from "@/components/AutoRefresh";
import { cancelBroadcastJob, retryFailedBroadcastMessages } from "@/server/actions/groupBroadcast";
import { JobActions } from "./JobActions";

const TERMINAL_JOB_STATUSES = new Set(["COMPLETED", "CANCELLED", "STOPPED_KILL_SWITCH"]);

export default async function GroupBroadcastJobPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await params;

  const job = await prisma.groupBroadcastJob.findUnique({
    where: { id },
    include: { account: { select: { label: true } }, createdBy: { select: { name: true, email: true } } },
  });
  if (!job) notFound();

  const messages = await prisma.outboundMessage.findMany({
    where: { broadcastJobId: id },
    orderBy: { scheduledAt: "asc" },
  });

  const counts = {
    total: job.queuedCount,
    pending: messages.filter((m) => m.status === "PENDING").length,
    processing: messages.filter((m) => m.status === "PROCESSING").length,
    sent: messages.filter((m) => m.status === "SENT").length,
    failed: messages.filter((m) => m.status === "FAILED").length,
    skipped: messages.filter((m) => m.status === "SKIPPED").length,
    cancelled: messages.filter((m) => m.status === "CANCELLED").length,
  };
  const settled = counts.sent + counts.failed + counts.skipped + counts.cancelled;
  const currentlyProcessing = messages.find((m) => m.status === "PROCESSING");
  const isTerminal = TERMINAL_JOB_STATUSES.has(job.status);

  const stopAction = cancelBroadcastJob.bind(null, job.id);
  const retryAction = retryFailedBroadcastMessages.bind(null, job.id);

  return (
    <div>
      <PageHeader title="Group Message Sending Progress" description={`Job ${job.id}`} />

      {job.status === "STOPPED_KILL_SWITCH" ? (
        <div className="mb-4">
          <Alert tone="danger" title="Stopped by kill switch">
            Automation was paused while this job was running. Already-sent messages remain SENT; the rest were
            cancelled. Resume automation on the Automation Control page, then retry if needed.
          </Alert>
        </div>
      ) : null}
      {job.status === "CANCELLED" ? (
        <div className="mb-4">
          <Alert tone="neutral">This job was cancelled by a user.</Alert>
        </div>
      ) : null}

      <Card className="mb-4">
        <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
          <Field label="Account" value={job.account.label} />
          <Field label="Created by" value={job.createdBy?.name ?? job.createdBy?.email ?? "—"} />
          <Field label="Created at" value={job.createdAt.toLocaleString()} />
          <Field
            label="Status"
            value={
              <Badge color={statusColor(job.status)} dot>
                {job.status}
              </Badge>
            }
          />
        </dl>
      </Card>

      <Card className="mb-4">
        <div className="mb-2 flex items-center justify-between text-sm">
          <span className="tabular-nums">
            {settled} / {counts.total}
          </span>
          {currentlyProcessing ? (
            <span className="text-[color:var(--color-muted-foreground)]">
              Sending to: {currentlyProcessing.groupNameSnapshot}
            </span>
          ) : null}
        </div>
        <ProgressBar value={settled} max={counts.total} />
        <div className="mt-4 grid grid-cols-3 gap-3 md:grid-cols-6">
          <StatTile label="Total" value={counts.total} />
          <StatTile label="Pending" value={counts.pending} />
          <StatTile label="Processing" value={counts.processing} tone={counts.processing > 0 ? "warning" : "neutral"} />
          <StatTile label="Sent" value={counts.sent} tone="success" />
          <StatTile label="Failed" value={counts.failed} tone={counts.failed > 0 ? "danger" : "neutral"} />
          <StatTile label="Skipped" value={counts.skipped} />
        </div>
      </Card>

      <JobActions
        showStop={!isTerminal}
        failedCount={job.status !== "CANCELLED" && job.status !== "STOPPED_KILL_SWITCH" ? counts.failed : 0}
        onStop={stopAction}
        onRetry={retryAction}
      />

      {job.preQueueSkipped > 0 ? (
        <Card className="mb-4">
          <p className="mb-1.5 text-sm font-medium text-[color:var(--color-foreground)]">
            {job.preQueueSkipped} group(s) were never queued (unmatched/ambiguous/duplicate/cooldown):
          </p>
          <ul className="list-inside list-disc text-sm text-[color:var(--color-muted-foreground)]">
            {(job.preQueueSkipReasons as Array<{ groupName: string; reason: string }>).map((s, i) => (
              <li key={i}>
                {s.groupName} — {s.reason}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Table>
        <thead>
          <tr>
            <Th>Group</Th>
            <Th>Status</Th>
            <Th>Sent At</Th>
            <Th>Attempts</Th>
            <Th>Failure Reason</Th>
            <Th>Provider Message ID</Th>
          </tr>
        </thead>
        <tbody>
          {messages.map((m) => (
            <tr key={m.id}>
              <Td>{m.groupNameSnapshot}</Td>
              <Td>
                <Badge color={messageStatusColor(m.status)} dot>
                  {m.status}
                </Badge>
              </Td>
              <Td>{m.sentAt?.toLocaleString() ?? "—"}</Td>
              <Td className="tabular-nums">{m.attemptCount}</Td>
              <Td className="max-w-xs">{m.failureReason ?? "—"}</Td>
              <Td className="font-[family-name:var(--font-mono)] text-xs">{m.providerMessageId ?? "—"}</Td>
            </tr>
          ))}
        </tbody>
      </Table>

      <p className="mt-4 text-xs">
        <Link
          href="/group-message-sender/history"
          className="text-[color:var(--color-muted-foreground)] underline hover:text-[color:var(--color-foreground)]"
        >
          Back to history
        </Link>
      </p>

      {!isTerminal ? <AutoRefresh intervalMs={3000} /> : null}
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-[color:var(--color-muted-foreground)]">{label}</dt>
      <dd className="mt-0.5 text-[color:var(--color-foreground)]">{value}</dd>
    </div>
  );
}

function statusColor(status: string): BadgeColor {
  if (status === "COMPLETED") return "green";
  if (status === "CANCELLED" || status === "STOPPED_KILL_SWITCH") return "red";
  if (status === "RUNNING") return "blue";
  return "gray";
}

function messageStatusColor(status: string): BadgeColor {
  if (status === "SENT") return "green";
  if (status === "FAILED") return "red";
  if (status === "SKIPPED" || status === "CANCELLED") return "gray";
  if (status === "PROCESSING") return "blue";
  return "yellow";
}
