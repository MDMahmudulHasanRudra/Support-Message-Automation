import { Prisma } from "@prisma/client";
import {
  decideBackupHealth,
  BACKUP_ALERT_MAX_ATTEMPTS,
  isConfirmedNonDelivery,
  nextBackupAlertAttempt,
  parseBackupStaleHours,
  redactText,
  sanitizeBackupReason,
  type BackupHealth,
} from "@support-automation/shared";
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
 * - One alert per outage per kind: the key names the newest success, and the `BackupAlert` row with that key
 *   is created once (unique insert), restarts included.
 * - Delivery is per recipient (`BackupAlertDelivery`, unique per alert + recipient). A send is CLAIMED first
 *   (QUEUED/FAILED → SENDING, a conditional update), so two ticks or two workers never send the same email.
 * - Only a CONFIRMED non-delivery is retried, on a bounded schedule (`nextBackupAlertAttempt`): the server
 *   refused, there was no platform email or no operator address, or the mail host was refused before any
 *   connection. A recipient already SENT is never sent again, so a partial success stays partial, never doubled.
 * - An outcome nobody can know is final: SMTP's UNKNOWN (dropped after the message was handed over), a thrown
 *   send, or a row left SENDING by a stopped worker — UNKNOWN, never resent.
 * - Only the CURRENT outage's alert is worked on: once a backup succeeds, an older alert's retries stop.
 * - Nothing about where the backups are or how to reach the database leaves the server: the email carries
 *   the status, times and a reason already stripped of paths, sanitised again here; a stored error is redacted.
 * - Read-only on backups: it never starts, schedules or restores one.
 * - Nothing is alerted before a first run is recorded (an install that has not set up backups is not nagged).
 *   BACKUP_ALERT_STALE_HOURS (default 26; 0 = no stale alerts) sets the staleness threshold.
 */

const LOOP_NAME = "backup-watch";
/** A delivery left SENDING this long was interrupted mid-send: it may have gone, so it becomes UNKNOWN. */
export const BACKUP_ALERT_SENDING_STUCK_MS = 10 * 60_000;

export interface BackupWatchDeps {
  mailer: PlatformMailer | null;
  send: SmtpSender;
  resolve: HostResolver;
}

export interface BackupWatchResult {
  health: BackupHealth;
  /**
   * What happened to the current alert on this check:
   *   none          the state calls for no alert
   *   sent          at least one recipient was reached on this check
   *   not-delivered something was tried and nobody was reached; a retry is scheduled
   *   waiting       a retry is scheduled but not due yet
   *   already-sent  nothing is left to do: every recipient is SENT, UNKNOWN or out of attempts
   *   gave-up       attempts are used up and nobody was ever reached
   */
  alert: "none" | "sent" | "not-delivered" | "waiting" | "already-sent" | "gave-up";
  /** Recipients reached on THIS check. */
  recipients: number;
}

const clean = (text: string) => sanitizeBackupReason(redactText(text)) ?? "Not delivered.";

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

/** The current alert row for this key: created once, found again on every later check. */
async function currentAlert(key: string, kind: string) {
  try {
    return await platformPrisma.backupAlert.create({ data: { key, kind } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return platformPrisma.backupAlert.findUniqueOrThrow({ where: { key } });
    }
    throw err;
  }
}

/** Nothing could be tried at all (no mailer, no recipient, refused host): pace the next try on the alert. */
async function alertLevelFailure(alertId: string, attempts: number, note: string, now: Date): Promise<"not-delivered" | "gave-up"> {
  const next = nextBackupAlertAttempt(attempts + 1, now);
  await platformPrisma.backupAlert.update({ where: { id: alertId }, data: { attempts: attempts + 1, nextAttemptAt: next, note: clean(note) } });
  return next ? "not-delivered" : "gave-up";
}

/**
 * With nothing due now: a retry still scheduled → waiting; anyone reached, or possibly reached (UNKNOWN) →
 * already-sent; otherwise every attempt was a confirmed failure and they are used up → gave-up.
 */
async function settledState(alertId: string): Promise<"waiting" | "already-sent" | "gave-up"> {
  const [pending, reached] = await Promise.all([
    platformPrisma.backupAlertDelivery.count({ where: { alertId, status: "FAILED", nextAttemptAt: { not: null } } }),
    platformPrisma.backupAlertDelivery.count({ where: { alertId, status: { in: ["SENT", "UNKNOWN"] } } }),
  ]);
  if (pending > 0) return "waiting";
  return reached > 0 ? "already-sent" : "gave-up";
}

async function summarise(alertId: string, problems: string[]) {
  const sent = await platformPrisma.backupAlertDelivery.count({ where: { alertId, status: "SENT" } });
  await platformPrisma.backupAlert.update({
    where: { id: alertId },
    data: { recipients: sent, delivered: sent > 0, note: problems.length ? clean(problems.join("; ")) : sent > 0 ? null : undefined },
  });
  return sent;
}

export async function checkBackupHealth(now: Date, staleHours: number, deps: BackupWatchDeps): Promise<BackupWatchResult> {
  const [latest, latestSuccess] = await Promise.all([
    platformPrisma.backupRun.findFirst({ orderBy: { finishedAt: "desc" }, select: { id: true, status: true, finishedAt: true, reason: true } }),
    platformPrisma.backupRun.findFirst({ where: { status: "SUCCEEDED" }, orderBy: { finishedAt: "desc" }, select: { id: true, status: true, finishedAt: true } }),
  ]);
  const health = decideBackupHealth({ latest, latestSuccess, now, staleHours });
  if (!health.alert || !latest) return { health, alert: "none", recipients: 0 };

  const alert = await currentAlert(health.alert.key, health.alert.kind);

  // A send interrupted by a stopped worker may have gone: never resend it.
  await platformPrisma.backupAlertDelivery.updateMany({
    where: { alertId: alert.id, status: "SENDING", sendingAt: { lt: new Date(now.getTime() - BACKUP_ALERT_SENDING_STUCK_MS) } },
    data: { status: "UNKNOWN", lastError: "The send was interrupted, so it is not known whether it arrived. It is not sent again." },
  });

  // Alert-level pacing: nothing could be tried last time.
  if (alert.nextAttemptAt && alert.nextAttemptAt > now) return { health, alert: "waiting", recipients: 0 };
  // Alert-level attempts used up (nothing could ever be tried): stop, without writing on every tick.
  const alertExhausted = alert.attempts >= BACKUP_ALERT_MAX_ATTEMPTS;

  if (!deps.mailer) {
    if (alertExhausted) return { health, alert: "gave-up", recipients: 0 };
    return { health, alert: await alertLevelFailure(alert.id, alert.attempts, "Platform email is not configured.", now), recipients: 0 };
  }
  const operators = await platformPrisma.platformOperator.findMany({ where: { isActive: true, email: { not: null } }, select: { email: true } });
  const to = [...new Set(operators.map((o) => o.email!.trim().toLowerCase()).filter(Boolean))];
  if (to.length === 0 && alertExhausted) return { health, alert: "gave-up", recipients: 0 };
  if (to.length === 0) return { health, alert: await alertLevelFailure(alert.id, alert.attempts, "No active platform operator has an email address.", now), recipients: 0 };

  // One delivery per recipient, created once; an operator added during the outage is included.
  await platformPrisma.backupAlertDelivery.createMany({ data: to.map((recipient) => ({ alertId: alert.id, recipient })), skipDuplicates: true });
  if (alert.nextAttemptAt) {
    await platformPrisma.backupAlert.update({ where: { id: alert.id }, data: { nextAttemptAt: null } });
  }

  const due = await platformPrisma.backupAlertDelivery.findMany({
    where: { alertId: alert.id, recipient: { in: to }, OR: [{ status: "QUEUED" }, { status: "FAILED", nextAttemptAt: { lte: now } }] },
    orderBy: { createdAt: "asc" },
  });
  if (due.length === 0) return { health, alert: await settledState(alert.id), recipients: 0 };

  // A refused mail host is a confirmed non-delivery for everyone due: nothing was sent.
  const refused = await checkHostIsAllowed(deps.mailer.connection.host, deps.resolve).catch((err: unknown) => ({ kind: "NOT_SENT" as const, message: err instanceof Error ? err.message : String(err) }));
  const email = alertText(health, latest, staleHours);
  const problems: string[] = [];
  let reachedNow = 0;

  for (const delivery of due) {
    const attempts = delivery.attempts + 1;
    if (refused) {
      const next = nextBackupAlertAttempt(attempts, now);
      await platformPrisma.backupAlertDelivery.updateMany({
        where: { id: delivery.id, status: delivery.status },
        data: { status: "FAILED", attempts, nextAttemptAt: next, lastError: clean(refused.message) },
      });
      problems.push(refused.message);
      continue;
    }
    // Claim it: only the claimer sends.
    const claim = await platformPrisma.backupAlertDelivery.updateMany({
      where: { id: delivery.id, status: delivery.status, attempts: delivery.attempts },
      data: { status: "SENDING", sendingAt: now, attempts },
    });
    if (claim.count === 0) continue;
    let outcome: Awaited<ReturnType<SmtpSender>> | { thrown: string };
    try {
      outcome = await deps.send(deps.mailer.connection, {
        fromName: deps.mailer.fromName,
        fromAddress: deps.mailer.fromAddress,
        replyTo: null,
        to: delivery.recipient,
        subject: email.subject,
        text: email.text,
        messageIdSeed: `${delivery.id}-${attempts}`,
      });
    } catch (err) {
      outcome = { thrown: err instanceof Error ? err.message : String(err) };
    }
    if ("thrown" in outcome) {
      // A throw from the transport tells us nothing about whether the server took it: never resend.
      await platformPrisma.backupAlertDelivery.update({ where: { id: delivery.id }, data: { status: "UNKNOWN", nextAttemptAt: null, lastError: clean(outcome.thrown) } });
      problems.push(outcome.thrown);
    } else if (outcome.ok) {
      await platformPrisma.backupAlertDelivery.update({ where: { id: delivery.id }, data: { status: "SENT", sentAt: new Date(), nextAttemptAt: null, lastError: null } });
      reachedNow++;
    } else if (isConfirmedNonDelivery(outcome.failure.kind)) {
      await platformPrisma.backupAlertDelivery.update({
        where: { id: delivery.id },
        data: { status: "FAILED", nextAttemptAt: nextBackupAlertAttempt(attempts, now), lastError: clean(outcome.failure.message) },
      });
      problems.push(outcome.failure.message);
    } else {
      await platformPrisma.backupAlertDelivery.update({ where: { id: delivery.id }, data: { status: "UNKNOWN", nextAttemptAt: null, lastError: clean(outcome.failure.message) } });
      problems.push(outcome.failure.message);
    }
  }

  await summarise(alert.id, problems);
  if (reachedNow > 0) return { health, alert: "sent", recipients: reachedNow };
  const settled = await settledState(alert.id);
  if (settled === "waiting") {
    console.warn(`[backup-watch] backup ${health.state.toLowerCase()}: the alert was not delivered; a retry is scheduled`);
    return { health, alert: "not-delivered", recipients: 0 };
  }
  return { health, alert: settled, recipients: 0 };
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
