import { StatusDot } from "@/components/ui";

/**
 * One account's group-list sync, as the worker last recorded it (WhatsAppAccount.groupSync*,
 * GROUP_SYNC.md). Read-only; the dashboard polls while a sync is RUNNING.
 */
export interface GroupSyncSummary {
  status: "RUNNING" | "COMPLETED" | "PARTIAL" | "FAILED" | "CANCELLED" | null;
  stage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  discovered: number | null;
  created: number | null;
  updated: number | null;
  deactivated: number | null;
  failed: number | null;
  durationMs: number | null;
  error: string | null;
}

/** The columns as the page reads them, for `toGroupSyncSummary`. */
export interface GroupSyncColumns {
  groupSyncStatus: GroupSyncSummary["status"];
  groupSyncStage: string | null;
  groupSyncStartedAt: Date | null;
  groupSyncCompletedAt: Date | null;
  groupSyncDiscovered: number | null;
  groupSyncNew: number | null;
  groupSyncUpdated: number | null;
  groupSyncDeactivated: number | null;
  groupSyncFailed: number | null;
  groupSyncDurationMs: number | null;
  groupSyncError: string | null;
}

export function toGroupSyncSummary(row: GroupSyncColumns): GroupSyncSummary {
  return {
    status: row.groupSyncStatus,
    stage: row.groupSyncStage,
    startedAt: row.groupSyncStartedAt?.toISOString() ?? null,
    completedAt: row.groupSyncCompletedAt?.toISOString() ?? null,
    discovered: row.groupSyncDiscovered,
    created: row.groupSyncNew,
    updated: row.groupSyncUpdated,
    deactivated: row.groupSyncDeactivated,
    failed: row.groupSyncFailed,
    durationMs: row.groupSyncDurationMs,
    error: row.groupSyncError,
  };
}

const n = (value: number | null) => (value ?? 0).toLocaleString("en-US");

function seconds(ms: number | null): string {
  if (ms === null) return "";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function GroupSyncStatusLine({ sync, label }: { sync: GroupSyncSummary; label?: string }) {
  if (!sync.status) {
    return <p className="text-xs text-[color:var(--color-muted-foreground)]">{label ? `${label}: ` : ""}Groups not synced yet.</p>;
  }
  const prefix = label ? <span className="font-medium text-[color:var(--color-foreground)]">{label}: </span> : null;

  if (sync.status === "RUNNING") {
    return (
      <p className="flex flex-wrap items-center gap-1.5 text-xs text-[color:var(--color-foreground)]">
        <StatusDot color="blue" pulse />
        {prefix}
        <span className="font-medium">Syncing groups</span>
        <span className="text-[color:var(--color-muted-foreground)]">
          — {sync.stage ?? "working"}
          {sync.discovered !== null ? ` · ${n(sync.discovered)} found so far` : ""}
        </span>
      </p>
    );
  }

  const when = sync.completedAt ? new Date(sync.completedAt).toLocaleString() : "";
  const changes = [
    `${n(sync.discovered)} groups`,
    sync.created ? `${n(sync.created)} new` : null,
    sync.updated ? `${n(sync.updated)} updated` : null,
    sync.deactivated ? `${n(sync.deactivated)} left` : null,
    sync.failed ? `${n(sync.failed)} not saved` : null,
  ]
    .filter(Boolean)
    .join(", ");

  if (sync.status === "CANCELLED") {
    // Stopped on purpose by a Logout or Reconnect — said plainly, never shown as a failure.
    return (
      <p suppressHydrationWarning className="flex flex-wrap items-center gap-1.5 text-xs text-[color:var(--color-muted-foreground)]">
        <StatusDot color="gray" />
        {prefix}
        <span className="font-medium text-[color:var(--color-foreground)]">Group sync stopped{when ? ` (${when})` : ""}</span>
        {sync.error ? <span>— {sync.error}</span> : null}
      </p>
    );
  }

  if (sync.status === "FAILED") {
    return (
      <p suppressHydrationWarning className="flex flex-wrap items-center gap-1.5 text-xs text-[color:var(--color-danger-fg)]">
        <StatusDot color="red" />
        {prefix}
        <span className="font-medium">Group sync failed{when ? ` (${when})` : ""}</span>
        {sync.error ? <span className="text-[color:var(--color-muted-foreground)]">— {sync.error}</span> : null}
      </p>
    );
  }

  return (
    <p suppressHydrationWarning className="flex flex-wrap items-center gap-1.5 text-xs text-[color:var(--color-muted-foreground)]">
      <StatusDot color={sync.status === "PARTIAL" ? "yellow" : "green"} />
      {prefix}
      <span className="font-medium text-[color:var(--color-foreground)]">
        {sync.status === "PARTIAL" ? "Groups synced with warnings" : "Groups synced"}
      </span>
      <span>
        — {changes}
        {when ? ` · ${when}` : ""}
        {sync.durationMs !== null ? ` · took ${seconds(sync.durationMs)}` : ""}
      </span>
      {sync.status === "PARTIAL" && sync.error ? <span className="w-full text-[color:var(--color-warning-fg)]">{sync.error}</span> : null}
    </p>
  );
}
