import { prisma as globalPrisma } from "@support-automation/db";
import { decideBackupHealth, parseBackupStaleHours, sanitizeBackupReason, type BackupHealthState } from "@support-automation/shared";

/**
 * Backup health for Platform → Monitoring (docs/get-assist-ultimate/19 §7). Platform operators only (the
 * page calls requireOperatorPage); read with the unscoped client because backups cover every customer.
 * The health is `decideBackupHealth`, the same rule the worker alerts on. Never a path or a credential:
 * the recorded reason is sanitised again before it is shown.
 */
export interface BackupFigures {
  state: BackupHealthState;
  staleHours: number;
  lastSuccessAt: Date | null;
  lastSuccessDatabaseBytes: number | null;
  lastSuccessMediaBytes: number | null;
  latest: { status: "SUCCEEDED" | "FAILED"; finishedAt: Date; reason: string | null } | null;
  runsLast7Days: { succeeded: number; failed: number };
  lastAlert: { kind: string; createdAt: Date; delivered: boolean; recipients: number } | null;
}

export async function backupFigures(now: Date = new Date()): Promise<BackupFigures> {
  const staleHours = parseBackupStaleHours(process.env.BACKUP_ALERT_STALE_HOURS);
  const since = new Date(now.getTime() - 7 * 24 * 3_600_000);
  const [latest, latestSuccess, byStatus, lastAlert] = await Promise.all([
    globalPrisma.backupRun.findFirst({ orderBy: { finishedAt: "desc" }, select: { id: true, status: true, finishedAt: true, reason: true } }),
    globalPrisma.backupRun.findFirst({ where: { status: "SUCCEEDED" }, orderBy: { finishedAt: "desc" }, select: { id: true, status: true, finishedAt: true, databaseBytes: true, mediaBytes: true } }),
    globalPrisma.backupRun.groupBy({ by: ["status"], where: { finishedAt: { gte: since } }, _count: { _all: true } }),
    globalPrisma.backupAlert.findFirst({ orderBy: { createdAt: "desc" }, select: { kind: true, createdAt: true, delivered: true, recipients: true } }),
  ]);
  const health = decideBackupHealth({ latest, latestSuccess, now, staleHours });
  const count = (s: "SUCCEEDED" | "FAILED") => byStatus.find((b) => b.status === s)?._count._all ?? 0;
  return {
    state: health.state,
    staleHours,
    lastSuccessAt: health.lastSuccessAt,
    lastSuccessDatabaseBytes: latestSuccess?.databaseBytes != null ? Number(latestSuccess.databaseBytes) : null,
    lastSuccessMediaBytes: latestSuccess?.mediaBytes != null ? Number(latestSuccess.mediaBytes) : null,
    latest: latest ? { status: latest.status, finishedAt: latest.finishedAt, reason: sanitizeBackupReason(latest.reason) } : null,
    runsLast7Days: { succeeded: count("SUCCEEDED"), failed: count("FAILED") },
    lastAlert,
  };
}
