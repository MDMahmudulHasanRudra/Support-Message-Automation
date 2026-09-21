import { notFound } from "next/navigation";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { Alert, Badge, type BadgeColor, Card, PageHeader, ProgressBar, StatTile, StatusDot, Table, Td, Th } from "@/components/ui";
import { AutoRefresh } from "@/components/AutoRefresh";
import { formatDateTime } from "@/lib/date";
import { cancelParticipantAddJob, recheckParticipantAddItems } from "@/server/actions/groupParticipantAdd";
import { JobActions } from "./JobActions";
import { MembershipReview } from "./MembershipReview";

const TERMINAL_JOB_STATUSES = new Set(["COMPLETED", "CANCELLED", "STOPPED_KILL_SWITCH"]);

/** Results of the membership check — everything decided before a single add was attempted. */
const CHECK_RESULT_STATUSES = [
  "READY",
  "CANNOT_VERIFY",
  "ALREADY_MEMBER",
  "INVALID_NUMBER",
  "NOT_ON_WHATSAPP",
  "NO_PERMISSION",
  "GROUP_UNAVAILABLE",
  "CHECK_FAILED",
] as const;

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

  const countOf = (status: string) => items.filter((i) => i.status === status).length;
  const counts = {
    total: job.queuedCount,
    pending: countOf("PENDING"),
    processing: countOf("PROCESSING"),
    added: countOf("ADDED"),
    failed: countOf("FAILED"),
    cancelled: countOf("CANCELLED"),
    skippedAlready: countOf("SKIPPED_ALREADY_MEMBER"),
  };
  const checkCounts = {
    outstanding: countOf("PENDING_CHECK") + countOf("CHECKING"),
    ready: countOf("READY"),
    cannotVerify: countOf("CANNOT_VERIFY"),
    alreadyMember: countOf("ALREADY_MEMBER"),
    invalid: countOf("INVALID_NUMBER") + countOf("NOT_ON_WHATSAPP"),
    blocked: countOf("NO_PERMISSION") + countOf("GROUP_UNAVAILABLE"),
    checkFailed: countOf("CHECK_FAILED"),
  };
  const settled = counts.added + counts.failed + counts.cancelled + counts.skippedAlready;
  const currentlyProcessing = items.find((i) => i.status === "PROCESSING");
  const isTerminal = TERMINAL_JOB_STATUSES.has(job.status);
  const isChecking = job.status === "CHECKING";
  const isAwaitingReview = job.status === "AWAITING_REVIEW";
  // The check phase and the review screen both need refreshing; only the add phase is "running".
  const shouldPoll = !isTerminal && !isAwaitingReview;

  const reviewRows = items
    .filter((i) => (CHECK_RESULT_STATUSES as readonly string[]).includes(i.status))
    .map((i) => ({
      id: i.id,
      phoneNumber: i.phoneNumber,
      groupName: i.groupNameSnapshot,
      status: i.status,
      reason: i.failureReason,
    }));

  const stopAction = cancelParticipantAddJob.bind(null, job.id);
  // Re-check rather than re-attempt — see JobActions for why a blind retry is the wrong shape here.
  const retryAction = async () => {
    "use server";
    await recheckParticipantAddItems(job.id);
  };

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
          {/* One job now covers several people, so the count leads and the numbers themselves go
              in the title — a job spanning a whole roster would otherwise push every other field
              off the row. */}
          <Field
            label={job.phoneNumbers.length === 1 ? "Phone number" : `Numbers (${job.phoneNumbers.length})`}
            value={
              <span title={job.phoneNumbers.join(", ")}>
                {job.phoneNumbers.length <= 2
                  ? job.phoneNumbers.join(", ") || "—"
                  : `${job.phoneNumbers.slice(0, 2).join(", ")} +${job.phoneNumbers.length - 2} more`}
              </span>
            }
          />
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

      {/* The check phase and the review screen are each a whole screen's worth of information, so
          they replace the progress card rather than sitting under it — the add-progress numbers
          are all zero until a person has approved something, and showing them would imply work is
          happening that deliberately is not. */}
      {isChecking ? (
        <Card className="mb-4">
          <div className="mb-2 flex items-center gap-2 text-base font-semibold text-[color:var(--color-foreground)]">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Checking who is already in each group
          </div>
          <p className="mb-3 text-sm text-[color:var(--color-muted-foreground)]">
            Reading each group&apos;s member list. Nothing is being added yet — you will be asked to
            confirm once this finishes. {checkCounts.outstanding} of {items.length} still to check.
          </p>
          <ProgressBar value={items.length - checkCounts.outstanding} max={items.length} />
        </Card>
      ) : null}

      {isAwaitingReview ? (
        <Card className="mb-4">
          <p className="mb-3 text-sm text-[color:var(--color-muted-foreground)]">
            {items.length} number/group combination{items.length === 1 ? "" : "s"} checked. Nothing has
            been added yet.
          </p>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
            <StatTile label="Ready to add" value={checkCounts.ready} tone={checkCounts.ready > 0 ? "success" : "neutral"} />
            <StatTile label="Cannot confirm" value={checkCounts.cannotVerify} tone={checkCounts.cannotVerify > 0 ? "warning" : "neutral"} />
            <StatTile label="Already members" value={checkCounts.alreadyMember} />
            <StatTile label="Unusable numbers" value={checkCounts.invalid} tone={checkCounts.invalid > 0 ? "danger" : "neutral"} />
            <StatTile label="Blocked" value={checkCounts.blocked} tone={checkCounts.blocked > 0 ? "danger" : "neutral"} />
            <StatTile label="Check failed" value={checkCounts.checkFailed} tone={checkCounts.checkFailed > 0 ? "warning" : "neutral"} />
          </div>
        </Card>
      ) : null}

      {isChecking || isAwaitingReview ? null : (
      <Card className="mb-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="flex items-center gap-2 text-base font-semibold tabular-nums text-[color:var(--color-foreground)]">
            {settled} / {counts.total}
            {!isTerminal ? <StatusDot color="blue" pulse /> : null}
          </span>
          {currentlyProcessing ? (
            <span className="flex items-center gap-1.5 text-[color:var(--color-muted-foreground)]">
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              Adding to: {currentlyProcessing.groupNameSnapshot}
            </span>
          ) : null}
        </div>
        <ProgressBar value={settled} max={counts.total} />
        <div className="mt-4 grid grid-cols-3 gap-3 md:grid-cols-6">
          <StatTile label="Selected" value={counts.total} />
          <StatTile label="Pending" value={counts.pending} />
          <StatTile label="Processing" value={counts.processing} tone={counts.processing > 0 ? "warning" : "neutral"} />
          <StatTile label="Added" value={counts.added} tone="success" />
          {/* Somebody who joined between the check and their turn. Not a failure — the outcome the
              pre-check exists to make rare, reported honestly when it still happens. */}
          <StatTile label="Already member" value={counts.skippedAlready} />
          <StatTile label="Failed" value={counts.failed} tone={counts.failed > 0 ? "danger" : "neutral"} />
        </div>
      </Card>
      )}

      {isAwaitingReview ? <MembershipReview jobId={job.id} rows={reviewRows} /> : null}

      {!isChecking && !isAwaitingReview ? (
        <JobActions
          showStop={!isTerminal}
          failedCount={job.status !== "CANCELLED" && job.status !== "STOPPED_KILL_SWITCH" ? counts.failed : 0}
          onStop={stopAction}
          onRetry={retryAction}
        />
      ) : null}

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

      {/* Suppressed during review — MembershipReview above is already the full per-pair table, and
          a second copy of the same rows underneath it would just be a list you cannot act on. */}
      {isAwaitingReview ? null : (
      <Table>
        <thead>
          <tr>
            <Th>Number</Th>
            <Th>Group</Th>
            <Th>Status</Th>
            <Th>Processed At</Th>
            <Th>Attempts</Th>
            <Th>Details</Th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.id}>
              <Td className="tabular whitespace-nowrap">{i.phoneNumber}</Td>
              <Td>{i.groupNameSnapshot}</Td>
              <Td>
                <Badge color={itemStatusColor(i.status)} dot>
                  {i.status}
                </Badge>
              </Td>
              <Td>{i.processedAt ? formatDateTime(i.processedAt) : "—"}</Td>
              <Td className="tabular-nums">{i.attemptCount}</Td>
              <Td className="max-w-xs">{i.failureReason ?? "—"}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
      )}

      <p className="mt-4 text-xs">
        <Link
          href="/group-member-adder"
          className="text-[color:var(--color-muted-foreground)] underline hover:text-[color:var(--color-foreground)]"
        >
          Back to Add Number to Groups
        </Link>
      </p>

      {/* Gated on work actually being in flight. A job AWAITING_REVIEW is waiting on a person and
          can sit there for an hour — refreshing under them every three seconds would discard the
          selection they were in the middle of making. */}
      {shouldPoll ? <AutoRefresh intervalMs={3000} /> : null}
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
