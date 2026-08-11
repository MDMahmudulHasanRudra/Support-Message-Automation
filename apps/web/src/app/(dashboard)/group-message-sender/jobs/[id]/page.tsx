import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { Badge, Button, Card, PageHeader, Table, Td, Th } from "@/components/ui";
import { AutoRefresh } from "@/components/AutoRefresh";
import { cancelBroadcastJob, retryFailedBroadcastMessages } from "@/server/actions/groupBroadcast";

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

  return (
    <div>
      <PageHeader title="Group Message Sending Progress" description={`Job ${job.id}`} />

      {job.status === "STOPPED_KILL_SWITCH" ? (
        <Card className="mb-4 border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950">
          <p className="text-sm font-semibold text-red-800 dark:text-red-300">STOPPED BY KILL SWITCH</p>
          <p className="text-sm text-red-700 dark:text-red-400">
            Automation was paused while this job was running. Already-sent messages remain SENT; the rest were
            cancelled. Resume automation on the Automation Control page, then retry if needed.
          </p>
        </Card>
      ) : null}
      {job.status === "CANCELLED" ? (
        <Card className="mb-4 border-zinc-300 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900">
          <p className="text-sm font-medium">This job was cancelled by a user.</p>
        </Card>
      ) : null}

      <Card className="mb-4">
        <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
          <Field label="Account" value={job.account.label} />
          <Field label="Created by" value={job.createdBy?.name ?? job.createdBy?.email ?? "—"} />
          <Field label="Created at" value={job.createdAt.toLocaleString()} />
          <Field label="Status" value={<Badge color={statusColor(job.status)}>{job.status}</Badge>} />
        </dl>
      </Card>

      <Card className="mb-4">
        <div className="mb-2 flex items-center justify-between text-sm">
          <span>
            {settled} / {counts.total}
          </span>
          {currentlyProcessing ? (
            <span className="text-zinc-500 dark:text-zinc-400">Sending to: {currentlyProcessing.groupNameSnapshot}</span>
          ) : null}
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-900">
          <div
            className="h-full bg-zinc-900 dark:bg-zinc-50"
            style={{ width: `${counts.total > 0 ? Math.round((settled / counts.total) * 100) : 0}%` }}
          />
        </div>
        <dl className="mt-4 grid grid-cols-3 gap-3 text-sm md:grid-cols-6">
          <Field label="Total" value={counts.total} />
          <Field label="Pending" value={counts.pending} />
          <Field label="Processing" value={counts.processing} />
          <Field label="Sent" value={counts.sent} />
          <Field label="Failed" value={counts.failed} />
          <Field label="Skipped" value={counts.skipped} />
        </dl>
      </Card>

      <div className="mb-4 flex gap-2">
        {!isTerminal ? (
          <form action={cancelBroadcastJob.bind(null, job.id)}>
            <Button variant="danger" type="submit">
              Stop Job
            </Button>
          </form>
        ) : null}
        {counts.failed > 0 && job.status !== "CANCELLED" && job.status !== "STOPPED_KILL_SWITCH" ? (
          <form action={retryFailedBroadcastMessages.bind(null, job.id)}>
            <Button variant="secondary" type="submit">
              Retry {counts.failed} Failed Message(s)
            </Button>
          </form>
        ) : null}
      </div>

      {job.preQueueSkipped > 0 ? (
        <Card className="mb-4">
          <p className="mb-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">
            {job.preQueueSkipped} group(s) were never queued (unmatched/ambiguous/duplicate/cooldown):
          </p>
          <ul className="list-inside list-disc text-sm text-zinc-500 dark:text-zinc-400">
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
                <Badge color={messageStatusColor(m.status)}>{m.status}</Badge>
              </Td>
              <Td>{m.sentAt?.toLocaleString() ?? "—"}</Td>
              <Td>{m.attemptCount}</Td>
              <Td className="max-w-xs">{m.failureReason ?? "—"}</Td>
              <Td>{m.providerMessageId ?? "—"}</Td>
            </tr>
          ))}
        </tbody>
      </Table>

      <p className="mt-4 text-xs text-zinc-500 dark:text-zinc-400">
        <Link href="/group-message-sender/history" className="underline">
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
      <dt className="text-xs text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function statusColor(status: string): "green" | "red" | "yellow" | "gray" | "blue" {
  if (status === "COMPLETED") return "green";
  if (status === "CANCELLED" || status === "STOPPED_KILL_SWITCH") return "red";
  if (status === "RUNNING") return "blue";
  return "gray";
}

function messageStatusColor(status: string): "green" | "red" | "yellow" | "gray" | "blue" {
  if (status === "SENT") return "green";
  if (status === "FAILED") return "red";
  if (status === "SKIPPED" || status === "CANCELLED") return "gray";
  if (status === "PROCESSING") return "blue";
  return "yellow";
}
