import { ADMIN_PROMOTION_JOB_LABELS } from "@support-automation/shared";
import Link from "@/components/ProjectLink";
import { Alert, Badge, type BadgeColor, ProgressBar, StatTile } from "@/components/ui";
import type { AdminPromotionJobSummary } from "@/server/groupAdminPromotion";

/**
 * One Admin Maker job's state, read from the rows the worker writes — so it reads the same on the
 * page that started it, after a refresh, or from another browser an hour later.
 */

export const JOB_STATUS_COLOR: Record<string, BadgeColor> = {
  CHECKING: "blue",
  RUNNING: "blue",
  PAUSED_DISCONNECTED: "yellow",
  STOPPED_KILL_SWITCH: "yellow",
  COMPLETED: "green",
  FAILED: "red",
  CANCELLED: "gray",
};

const count = (n: number) => n.toLocaleString("en-US");

export function formatTarget(digits: string): string {
  return `+${digits}`;
}

export function AdminJobProgress({ job, showLink = false }: { job: AdminPromotionJobSummary; showLink?: boolean }) {
  const { counts } = job;
  const checking = job.status === "CHECKING";
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-[color:var(--color-muted-foreground)]">Target</p>
          <p className="tabular text-base font-semibold text-[color:var(--color-foreground)]">{formatTarget(job.phoneNumber)}</p>
          <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">via {job.accountLabel}</p>
        </div>
        <div className="flex items-center gap-3">
          <Badge color={JOB_STATUS_COLOR[job.status] ?? "gray"} dot>
            {ADMIN_PROMOTION_JOB_LABELS[job.status] ?? job.status}
          </Badge>
          {showLink ? (
            <Link href={`/group-admin-maker/jobs/${job.id}`} className="link text-[13px]">
              View details
            </Link>
          ) : null}
        </div>
      </div>

      {job.status === "PAUSED_DISCONNECTED" ? (
        <div className="mb-3">
          <Alert tone="warning" title="Connection lost">
            {job.statusReason} Processed: {count(counts.checked)} / {count(counts.total)}.
          </Alert>
        </div>
      ) : null}
      {job.status === "STOPPED_KILL_SWITCH" || job.status === "FAILED" || job.status === "CANCELLED" ? (
        <div className="mb-3">
          <Alert tone={job.status === "FAILED" ? "danger" : "warning"}>{job.statusReason}</Alert>
        </div>
      ) : null}
      {job.status === "COMPLETED" ? (
        <div className="mb-3">
          <Alert tone="success" title="Admin Maker complete">
            Every group has a result.{counts.failed > 0 ? ` ${count(counts.failed)} failed — see the details for WhatsApp's reason.` : ""}
          </Alert>
        </div>
      ) : null}

      <div className="mb-2 flex items-baseline justify-between text-[13px] text-[color:var(--color-muted-foreground)]">
        <span>{checking ? "Checking which groups this account administers…" : "Groups checked"}</span>
        <span className="tabular font-medium text-[color:var(--color-foreground)]">
          {count(counts.checked)} / {count(counts.total)}
        </span>
      </div>
      <ProgressBar value={counts.checked} max={counts.total} />

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <StatTile label="Eligible groups" value={job.adminGroups === null ? "…" : count(job.adminGroups)} hint="this account is an admin" />
        <StatTile label="Promoted" value={count(counts.promoted)} tone={counts.promoted > 0 ? "success" : "neutral"} />
        <StatTile label="Already admin" value={count(counts.alreadyAdmin)} />
        <StatTile label="Not a member" value={count(counts.notMember)} hint="never added" />
        <StatTile label="Skipped" value={count(counts.skipped)} hint="account is not an admin" />
        <StatTile label="Could not verify" value={count(counts.cannotVerify)} hint="members listed by internal id" />
        <StatTile label="Unavailable" value={count(counts.unavailable)} />
        <StatTile label="Failed" value={count(counts.failed)} tone={counts.failed > 0 ? "danger" : "neutral"} />
      </div>
    </div>
  );
}
