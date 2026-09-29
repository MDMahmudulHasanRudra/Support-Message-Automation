import { trackTick } from "../lifecycle.js";
import { logSystemEvent } from "../logging/logSystemEvent.js";
import { platformPrisma, prisma } from "../db.js";
import { accountInCurrentProject, withProject } from "../project/context.js";
import type { Notification } from "@prisma/client";
import type { NotificationProvider } from "./NotificationProvider.js";
import { recordLoopTick, registerLoop } from "../health/loopLiveness.js";

/** Name this loop reports itself under in the per-loop liveness view. */
const LOOP_NAME = "notification-dispatcher";

const STUCK_PROCESSING_TIMEOUT_MS = 2 * 60_000;
const MAX_NOTIFICATION_ATTEMPTS = 3;

export async function recoverStuckNotifications(): Promise<number> {
  const cutoff = new Date(Date.now() - STUCK_PROCESSING_TIMEOUT_MS);
  // Install-wide on purpose: it releases this worker's own stranded claims, whichever project
  // queued them, and changes nothing but the status.
  const result = await platformPrisma.notification.updateMany({
    where: { status: "RETRYING", updatedAt: { lt: cutoff } },
    data: { status: "PENDING" },
  });
  return result.count;
}

/**
 * Claims exactly one PENDING row by flipping it to RETRYING, this table's in-flight marker.
 *
 * Deliberately does NOT consider RETRYING rows: the claim guard then read `RETRYING -> RETRYING`,
 * which a row already being sent by an earlier slow tick passes, so the same notification went out
 * again on every subsequent tick. Rows genuinely orphaned by a crash are re-armed to PENDING by
 * recoverStuckNotifications() above — self-healing does not need the claim to be permissive.
 *
 * attemptCount is incremented in this same write rather than after the send: the attempt is what
 * is being claimed, so the count moves atomically instead of being written back from a value read
 * before the provider call.
 */
async function claimNextNotification() {
  // One shared queue in one global order (see claimNextOutboundMessage); the rest of the work runs
  // inside the claimed row's own project.
  const candidate = await platformPrisma.notification.findFirst({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
  });
  if (!candidate) return null;

  const claim = await platformPrisma.notification.updateMany({
    where: { id: candidate.id, status: "PENDING" },
    data: { status: "RETRYING", lastAttemptAt: new Date(), attemptCount: { increment: 1 } },
  });
  if (claim.count === 0) return null;

  return platformPrisma.notification.findUniqueOrThrow({ where: { id: candidate.id } });
}

/**
 * Notifications are dispatched independently of the automation kill switch —
 * "Continue notifying the support team if configured" applies even while
 * automatic client replies are paused.
 */
/** Exported for direct testing — dispatches exactly one due notification, or returns false if none. */
export async function processOneNotification(providers: Record<string, NotificationProvider>): Promise<boolean> {
  const notification = await claimNextNotification();
  if (!notification) return false;
  await withProject(notification.projectId, () => dispatchClaimedNotification(notification, providers));
  return true;
}

async function dispatchClaimedNotification(
  notification: Notification,
  providers: Record<string, NotificationProvider>,
): Promise<boolean> {
  // A WhatsApp alert goes out from the account resolved at enqueue time; that account must belong
  // to the project that raised the alert. Refused and logged otherwise — never sent from another
  // project's number (MULTI_PROJECT_PLAN.md Phase 3).
  if (notification.accountId && !(await accountInCurrentProject(notification.accountId))) {
    await prisma.notification.update({
      where: { id: notification.id },
      data: {
        status: "FAILED",
        failureReason: "The sending WhatsApp account belongs to a different project, so the alert was not sent.",
      },
    });
    await logSystemEvent("ERROR", "notifications", "Refused to send an alert through an account outside its project", {
      notificationId: notification.id,
      accountId: notification.accountId,
      notificationProjectId: notification.projectId,
    }).catch(() => undefined);
    return true;
  }

  const provider = providers[notification.type];
  if (!provider) {
    await prisma.notification.update({
      where: { id: notification.id },
      data: { status: "FAILED", failureReason: `No provider configured for type ${notification.type}.` },
    });
    return true;
  }

  // Already incremented by the claim, so this is the count the database actually holds.
  const attemptCount = notification.attemptCount;
  try {
    const result = await provider.send(notification.destination, notification.payload as Record<string, unknown>, notification.accountId);
    if (result.success) {
      await prisma.notification.update({
        where: { id: notification.id },
        data: { status: "SENT", sentAt: new Date() },
      });
    } else {
      await handleFailure(notification.id, attemptCount, result.error ?? "Unknown notification error");
    }
  } catch (err) {
    await handleFailure(notification.id, attemptCount, (err as Error).message);
  }
  return true;
}

async function handleFailure(id: string, attemptCount: number, failureReason: string): Promise<void> {
  const givingUp = attemptCount >= MAX_NOTIFICATION_ATTEMPTS;
  await prisma.notification.update({
    where: { id },
    data: { status: givingUp ? "FAILED" : "PENDING", failureReason },
  });

  // An alert that was never delivered is the worst thing this module can do quietly, and this file
  // did not import logSystemEvent at all — so it was console-only. The whole premise of an alert is
  // that somebody finds out; one that failed and said so nowhere durable inverts that exactly.
  // Retries in progress stay console-quiet, because a transient webhook failure that then succeeds
  // is not an event.
  if (givingUp) {
    await logSystemEvent("ERROR", "notifications", "Gave up delivering a notification after every retry", {
      notificationId: id,
      attemptCount,
      failureReason,
    }).catch(() => undefined);
  }
}

export function startNotificationDispatcher(
  providers: Record<string, NotificationProvider>,
  intervalMs = 3000,
): NodeJS.Timeout {
  // Same overlap guard every other loop in the worker uses (ENGINEERING_STANDARDS.md §9 "no
  // concurrent duplicate workers"): setInterval doesn't await its callback, so a slow Teams webhook
  // or WhatsApp send could otherwise let the next tick start dispatching alongside it.
  // Declared before the first tick, so a loop that dies on its very first run shows as
  // "never ticked" rather than not appearing in the liveness view at all.
  registerLoop(LOOP_NAME, intervalMs);
  let processing = false;
  return setInterval(() => {
    if (processing) return;
    processing = true;
    // Wrapped so shutdown can wait for a claim already in flight and refuse to start a new one.
    // Without it, SIGTERM during this tick killed the process mid-work and left the claimed row
    // PROCESSING until the next boot requeued and re-ran it — see lifecycle.ts.
    void trackTick(() => processOneNotification(providers))
      .catch((err) => {
        console.error("[notifications] unexpected error dispatching notification", err);
      })
      .finally(() => {
        processing = false;
        // Stamped when the tick FINISHES, which is the only moment that proves the loop is not
        // wedged — a guard that never clears is exactly how one of these dies silently.
        recordLoopTick(LOOP_NAME, intervalMs);
      });
  }, intervalMs);
}
