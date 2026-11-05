import { Alert, SectionHeader, StatTile } from "@/components/ui";
import type { BackupFigures } from "@/server/platform/backups";
import { formatBytes } from "./customers/[id]/CustomerHealthPanel";

const when = (at: Date | null) => (at ? new Date(at).toLocaleString() : "never");

/** Backups on Platform → Overview (docs/get-assist-ultimate/19 §7). Shows what was recorded; runs nothing. */
export function BackupHealthSection({ backups }: { backups: BackupFigures | null }) {
  if (!backups) {
    return (
      <div className="mb-8">
        <SectionHeader title="Backups" />
        <Alert tone="warning">Backup health could not be read just now.</Alert>
      </div>
    );
  }
  const { state, latest, lastAlert } = backups;
  const tone = state === "OK" ? "success" : state === "NONE" ? "neutral" : "danger";
  const label = state === "OK" ? "Healthy" : state === "NONE" ? "No backup recorded" : state === "FAILED" ? "Last run failed" : "Out of date";
  return (
    <div className="mb-8">
      <SectionHeader
        title="Backups"
        description={`Recorded by the backup script at the end of every run. Operators are emailed when a run fails or no backup has succeeded for ${backups.staleHours || "—"} hours.`}
      />
      {state === "NONE" ? (
        <div className="mb-3">
          <Alert tone="info" title="No backup has been recorded yet">
            Nothing is alerted until the first run. Schedule scripts/backup.sh on the server (docs/get-assist-ultimate/19-backup-and-restore.md).
          </Alert>
        </div>
      ) : state !== "OK" ? (
        <div className="mb-3">
          <Alert tone="danger" title={state === "FAILED" ? "The latest backup failed" : "Backups are out of date"}>
            {state === "FAILED" && latest?.reason ? `${latest.reason} ` : ""}Last successful backup: {when(backups.lastSuccessAt)}.
          </Alert>
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Backup health" value={label} tone={tone} />
        <StatTile
          label="Last successful backup"
          value={when(backups.lastSuccessAt)}
          hint={
            backups.lastSuccessDatabaseBytes != null
              ? `database ${formatBytes(backups.lastSuccessDatabaseBytes)}${backups.lastSuccessMediaBytes != null ? ` · media ${formatBytes(backups.lastSuccessMediaBytes)}` : ""}`
              : undefined
          }
        />
        <StatTile
          label="Runs, last 7 days"
          value={`${backups.runsLast7Days.succeeded} ok / ${backups.runsLast7Days.failed} failed`}
          tone={backups.runsLast7Days.failed > 0 ? "warning" : "neutral"}
          hint={latest ? `latest ${latest.status === "SUCCEEDED" ? "succeeded" : "failed"} ${when(latest.finishedAt)}` : undefined}
        />
        <StatTile
          label="Last alert"
          value={lastAlert ? (lastAlert.kind === "FAILED" ? "Failure" : "Out of date") : "None"}
          tone={lastAlert && !lastAlert.delivered ? "warning" : "neutral"}
          hint={lastAlert ? `${when(lastAlert.createdAt)} · ${lastAlert.delivered ? `emailed ${lastAlert.recipients}` : "not delivered — check platform email"}` : undefined}
        />
      </div>
    </div>
  );
}
