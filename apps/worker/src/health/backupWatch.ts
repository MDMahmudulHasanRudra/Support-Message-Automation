import { Prisma } from "@prisma/client";
import { decideBackupHealth, parseBackupStaleHours, sanitizeBackupReason, type BackupHealth } from "@support-automation/shared";
import { platformPrisma } from "../db.js";
import { platformMailer, type PlatformMailer } from "../billing/billingProcessor.js";
import { checkHostIsAllowed, resolveHostAddresses, sendWithNodemailer, type HostResolver, type SmtpSender } from "../email/smtpTransport.js";
import { recordLoopTick, registerLoop } from "./loopLiveness.js";

/**
 * Backup alerts (docs/get-assist-ultimate/19-backup-and-restore.md §7). scripts/backup.sh records every run
 * in `BackupRun`; this reads the newest run and the newest success, decides with `decideBackupHealth`
 * (packages/shared, the same rule Platform Monitoring shows), and emails the active platform operators when
 * the newest run FAILED or the newest success is STALE.
 *
 * - One alert per outage per kind: the key names the newest success, and a `BackupAlert` row with that key
 *   is CLAIMED (unique insert) before anything is sent, so a restart or a second worker cannot send it twice.
 * - Nothing about where the backups are or how to reach the database leaves the server: the email carries
 *   the status, times and a reason already stripped of paths, sanitised again here.
 * - Read-only on backups: it never starts, schedules or restores one.
 * - Nothing is alerted before a first run is recorded (an install that has not set up backups is not nagged).
 *   BACKUP_ALERT_STALE_HOURS (default 26; 0 = no stale alerts) sets the staleness threshold.
 */

const LOOP_NAME = "backup-watch";

export interface BackupWatchDeps {
  mailer: PlatformMailer | null;
  send: SmtpSender;
  resolve: HostResolver;
}

export interface BackupWatchResult {
  health: BackupHealth;
  /** What happened to the alert this state calls for, if any. */
  alert: "none" | "already-sent" | "sent" | "not-delivered";
  recipients: number;
}

function formatUtc(at: Date | null): string {
  return at ? `${at.toISOString().replace("T", " ").slice(0, 16)} UTC` : "never";
}

function alertText(health: BackupHealth, latest: { status: string; finishedAt: Date; reason: string | null }, staleHours: number) {
  const lastGood = formatUtc(health.lastSuccessAt);
  if (health.state === "FAILED") {
    return {
      subject: "Backup failed",
      text: [
        `The latest backup run failed at ${formatUtc(latest.finishedAt)}.`,
        `Reason: ${sanitizeBackupReason(latest.reason) ?? "not recorded"}.`,
        `Last successful backup: ${lastGood}.`,
        "",
        "Check the backup log on the server and run the backup again. Platform Monitoring shows the current backup health.",
        "You will not be emailed about further failures until a backup succeeds again.",
      ].join("\n"),
    };
  }
  return {
    subject: "Backups are out of date",
    text: [
      `No backup has succeeded in the last ${staleHours} hours. Last successful backup: ${lastGood}.`,
      `Latest run: ${latest.status === "SUCCEEDED" ? "succeeded" : "failed"} at ${formatUtc(latest.finishedAt)}.`,
      "",
      "Check that the scheduled backup is still running on the server. Platform Monitoring shows the current backup health.",
    ].join("\n"),
  };
}

export async function checkBackupHealth(now: Date, staleHours: number, deps: BackupWatchDeps): Promise<BackupWatchResult> {
  const [latest, latestSuccess] = await Promise.all([
    platformPrisma.backupRun.findFirst({ orderBy: { finishedAt: "desc" }, select: { id: true, status: true, finishedAt: true, reason: true } }),
    platformPrisma.backupRun.findFirst({ where: { status: "SUCCEEDED" }, orderBy: { finishedAt: "desc" }, select: { id: true, status: true, finishedAt: true } }),
  ]);
  const health = decideBackupHealth({ latest, latestSuccess, now, staleHours });
  if (!health.alert || !latest) return { health, alert: "none", recipients: 0 };

  // Claim the alert first: the unique key is what makes it happen once.
  let alertId: string;
  try {
    alertId = (await platformPrisma.backupAlert.create({ data: { key: health.alert.key, kind: health.alert.kind }, select: { id: true } })).id;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return { health, alert: "already-sent", recipients: 0 };
    throw err;
  }

  const operators = await platformPrisma.platformOperator.findMany({ where: { isActive: true, email: { not: null } }, select: { email: true } });
  const to = [...new Set(operators.map((o) => o.email!.trim().toLowerCase()).filter(Boolean))];
  const email = alertText(health, latest, staleHours);
  let delivered = 0;
  const problems: string[] = [];
  if (!deps.mailer) problems.push("Platform email is not configured.");
  else if (to.length === 0) problems.push("No active platform operator has an email address.");
  else {
    const refused = await checkHostIsAllowed(deps.mailer.connection.host, deps.resolve).catch((err: unknown) => ({ message: err instanceof Error ? err.message : String(err) }));
    if (refused) problems.push(refused.message);
    else {
      for (const address of to) {
        try {
          const outcome = await deps.send(deps.mailer.connection, {
            fromName: deps.mailer.fromName,
            fromAddress: deps.mailer.fromAddress,
            replyTo: null,
            to: address,
            subject: email.subject,
            text: email.text,
            messageIdSeed: `${alertId}-${delivered + problems.length}`,
          });
          if (outcome.ok) delivered++;
          else problems.push(outcome.failure.message);
        } catch (err) {
          problems.push(err instanceof Error ? err.message : String(err));
        }
      }
    }
  }
  await platformPrisma.backupAlert.update({
    where: { id: alertId },
    data: { recipients: delivered, delivered: delivered > 0, note: problems.length ? sanitizeBackupReason(problems.join("; ")) : null },
  });
  if (delivered === 0) console.warn(`[backup-watch] backup ${health.state.toLowerCase()}: the alert could not be delivered (${problems.length} problem(s))`);
  return { health, alert: delivered > 0 ? "sent" : "not-delivered", recipients: delivered };
}

export function startBackupWatch(intervalMs = 15 * 60_000, env: NodeJS.ProcessEnv = process.env): NodeJS.Timeout {
  registerLoop(LOOP_NAME, intervalMs);
  const staleHours = parseBackupStaleHours(env.BACKUP_ALERT_STALE_HOURS);
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    void (async () => checkBackupHealth(new Date(), staleHours, { mailer: await platformMailer(env), send: sendWithNodemailer, resolve: resolveHostAddresses }))()
      .catch((err) => console.error("[backup-watch] check failed", err))
      .finally(() => {
        running = false;
        recordLoopTick(LOOP_NAME, intervalMs);
      });
  }, intervalMs);
}
