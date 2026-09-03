import { prisma } from "@support-automation/db";
import type { NotificationProvider } from "./NotificationProvider.js";

const STUCK_PROCESSING_TIMEOUT_MS = 2 * 60_000;
const MAX_NOTIFICATION_ATTEMPTS = 3;

export async function recoverStuckNotifications(): Promise<number> {
  const cutoff = new Date(Date.now() - STUCK_PROCESSING_TIMEOUT_MS);
  const result = await prisma.notification.updateMany({
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
  const candidate = await prisma.notification.findFirst({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
  });
  if (!candidate) return null;

  const claim = await prisma.notification.updateMany({
    where: { id: candidate.id, status: "PENDING" },
    data: { status: "RETRYING", lastAttemptAt: new Date(), attemptCount: { increment: 1 } },
  });
  if (claim.count === 0) return null;

  return prisma.notification.findUniqueOrThrow({ where: { id: candidate.id } });
}

/**
 * Notifications are dispatched independently of the automation kill switch —
 * "Continue notifying the support team if configured" applies even while
 * automatic client replies are paused.
 */
async function processOneNotification(providers: Record<string, NotificationProvider>): Promise<boolean> {
  const notification = await claimNextNotification();
  if (!notification) return false;

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
  await prisma.notification.update({
    where: { id },
    data: { status: attemptCount >= MAX_NOTIFICATION_ATTEMPTS ? "FAILED" : "PENDING", failureReason },
  });
}

export function startNotificationDispatcher(
  providers: Record<string, NotificationProvider>,
  intervalMs = 3000,
): NodeJS.Timeout {
  // Same overlap guard every other loop in the worker uses (ENGINEERING_STANDARDS.md §9 "no
  // concurrent duplicate workers"): setInterval doesn't await its callback, so a slow Teams webhook
  // or WhatsApp send could otherwise let the next tick start dispatching alongside it.
  let processing = false;
  return setInterval(() => {
    if (processing) return;
    processing = true;
    processOneNotification(providers)
      .catch((err) => {
        console.error("[notifications] unexpected error dispatching notification", err);
      })
      .finally(() => {
        processing = false;
      });
  }, intervalMs);
}
