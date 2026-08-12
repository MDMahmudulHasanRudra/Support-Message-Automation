import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { Alert, Badge, type BadgeColor, Card, PageHeader, ProgressBar, StatTile, Table, Td, Th } from "@/components/ui";
import { AutoRefresh } from "@/components/AutoRefresh";
import { cancelParticipantAddJob, retryFailedParticipantAddItems } from "@/server/actions/groupParticipantAdd";
import { JobActions } from "./JobActions";

const TERMINAL_JOB_STATUSES = new Set(["COMPLETED", "CANCELLED", "STOPPED_KILL_SWITCH"]);

export default async function GroupParticipantAddJobPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await params;

  const job = await prisma.groupParticipantAddJob.findUnique({
    where: { id },
    include: { account: { select: { label: true } }, createdBy: { select: { name: true, email: true } } },
  });
  if (!job) notFound();

  const items = await prisma.groupParticipantAddItem.findMany({
    where: { jobId: id },
    orderBy: { scheduledAt: "asc" },
  });

  const counts = {
    total: job.queuedCount,
    pending: items.filter((i) => i.status === "PENDING").length,
    processing: items.filter((i) => i.status === "PROCESSING").length,
    added: items.filter((i) => i.status === "ADDED").length,
    failed: items.filter((i) => i.status === "FAILED").length,
    cancelled: items.filter((i) => i.status === "CANCELLED").length,
  };
  const settled = counts.added + counts.failed + counts.cancelled;
  const currentlyProcessing = items.find((i) => i.status === "PROCESSING");
  const isTerminal = TERMINAL_JOB_STATUSES.has(job.status);

  const stopAction = cancelParticipantAddJob.bind(null, job.id);
  const retryAction = retryFailedParticipantAddItems.bind(null, job.id);

  return (
    <div>
      <PageHeader title="Add-to-Groups Progress" description={`Job ${job.id}`} />

      {job.status === "STOPPED_KILL_SWITCH" ? (
        <div className="mb-4">
          <Alert tone="danger" title="Stopped by kill switch">
            Automation was paused while this job was running. Groups already added to remain ADDED; the rest were
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
          <Field label="Phone number" value={job.phoneNumber} />
          <Field label="Created by" value={job.createdBy?.name ?? job.createdBy?.email ?? "—"} />
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
              Adding to: {currentlyProcessing.groupNameSnapshot}
            </span>
          ) : null}
        </div>
        <ProgressBar value={settled} max={counts.total} />
        <div className="mt-4 grid grid-cols-3 gap-3 md:grid-cols-5">
          <StatTile label="Total" value={counts.total} />
          <StatTile label="Pending" value={counts.pending} />
          <StatTile label="Processing" value={counts.processing} tone={counts.processing > 0 ? "warning" : "neutral"} />
          <StatTile label="Added" value={counts.added} tone="success" />
          <StatTile label="Failed" value={counts.failed} tone={counts.failed > 0 ? "danger" : "neutral"} />
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
            {job.preQueueSkipped} group(s) were never queued:
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
            <Th>Processed At</Th>
            <Th>Attempts</Th>
            <Th>Failure Reason</Th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.id}>
              <Td>{i.groupNameSnapshot}</Td>
              <Td>
                <Badge color={itemStatusColor(i.status)} dot>
                  {i.status}
                </Badge>
              </Td>
              <Td>{i.processedAt?.toLocaleString() ?? "—"}</Td>
              <Td className="tabular-nums">{i.attemptCount}</Td>
              <Td className="max-w-xs">{i.failureReason ?? "—"}</Td>
            </tr>
          ))}
        </tbody>
      </Table>

      <p className="mt-4 text-xs">
        <Link
          href="/group-member-adder"
          className="text-[color:var(--color-muted-foreground)] underline hover:text-[color:var(--color-foreground)]"
        >
          Back to Add Number to Groups
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

function itemStatusColor(status: string): BadgeColor {
  if (status === "ADDED") return "green";
  if (status === "FAILED") return "red";
  if (status === "CANCELLED") return "gray";
  if (status === "PROCESSING") return "blue";
  return "yellow";
}
