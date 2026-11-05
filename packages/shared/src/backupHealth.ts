/**
 * Backup health (docs/get-assist-ultimate/19-backup-and-restore.md §7): what the recorded backup runs say,
 * and whether platform operators should be told. One rule for the worker's alert and the Platform
 * Monitoring card, so the two cannot disagree. Pure.
 *
 *   NONE     no run has ever been recorded — backups are not set up yet. Shown, never alerted: an
 *            installation that has not scheduled backups is not nagged every hour.
 *   OK       the newest run succeeded and the newest success is recent enough.
 *   FAILED   the newest run failed.
 *   STALE    runs exist, but the newest success is older than the threshold (or there never was one).
 *
 * Alerts are keyed by the newest SUCCESS ("since"), not by the failing run: an outage produces at most one
 * FAILED alert and one STALE alert, however many times the backup fails meanwhile, and a new success opens
 * a new key. The worker claims the key before sending, so a restart cannot send it twice.
 */

export type BackupHealthState = "NONE" | "OK" | "FAILED" | "STALE";
export type BackupAlertKind = "FAILED" | "STALE";

export const BACKUP_STALE_DEFAULT_HOURS = 26;

export interface BackupRunFacts {
  id: string;
  status: "SUCCEEDED" | "FAILED";
  finishedAt: Date;
}

export interface BackupHealth {
  state: BackupHealthState;
  /** The alert this state calls for, or null. */
  alert: { kind: BackupAlertKind; key: string } | null;
  lastSuccessAt: Date | null;
}

/** Reads BACKUP_ALERT_STALE_HOURS: unset = 26; 0 = never alert on staleness; anything unreadable = 26. */
export function parseBackupStaleHours(raw: string | undefined): number {
  const value = (raw ?? "").trim();
  if (value === "") return BACKUP_STALE_DEFAULT_HOURS;
  if (!/^\d+$/.test(value)) return BACKUP_STALE_DEFAULT_HOURS;
  return Number(value);
}

export function decideBackupHealth(input: {
  latest: BackupRunFacts | null;
  latestSuccess: BackupRunFacts | null;
  now: Date;
  staleHours: number;
}): BackupHealth {
  const { latest, latestSuccess, now, staleHours } = input;
  const lastSuccessAt = latestSuccess?.finishedAt ?? null;
  if (!latest) return { state: "NONE", alert: null, lastSuccessAt };
  const since = latestSuccess ? latestSuccess.id : "never";
  if (latest.status === "FAILED") return { state: "FAILED", alert: { kind: "FAILED", key: `FAILED:${since}` }, lastSuccessAt };
  const stale = staleHours > 0 && (!lastSuccessAt || now.getTime() - lastSuccessAt.getTime() > staleHours * 60 * 60_000);
  if (stale) return { state: "STALE", alert: { kind: "STALE", key: `STALE:${since}` }, lastSuccessAt };
  return { state: "OK", alert: null, lastSuccessAt };
}

/**
 * What a backup failure reason may say outside the server: no file paths (they name the backup location),
 * no host or credential. The script already strips paths; this is the second line, applied again here.
 */
export function sanitizeBackupReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const cleaned = reason
    .replace(/(?:[A-Za-z]:)?(?:[\\/][^\s"']+)+/g, "[path]")
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[connection]")
    .replace(/\b(?:password|passwd|pwd|secret|token)\s*[=:]\s*\S+/gi, "[secret]")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, 300) || null;
}
