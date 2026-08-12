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

async function claimNextNotification() {
  const candidate = await prisma.notification.findFirst({
    where: { status: { in: ["PENDING", "RETRYING"] } },
    orderBy: { createdAt: "asc" },
  });
  if (!candidate) return null;

  const claim = await prisma.notification.updateMany({
    where: { id: candidate.id, status: candidate.status },
    data: { status: "RETRYING", lastAttemptAt: new Date() },
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

  const attemptCount = notification.attemptCount + 1;
  try {
    const result = await provider.send(notification.destination, notification.payload as Record<string, unknown>, notification.accountId);
    if (result.success) {
      await prisma.notification.update({
        where: { id: notification.id },
        data: { status: "SENT", sentAt: new Date(), attemptCount },
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
  if (attemptCount >= MAX_NOTIFICATION_ATTEMPTS) {
    await prisma.notification.update({
      where: { id },
      data: { status: "FAILED", attemptCount, failureReason },
    });
    return;
  }
  await prisma.notification.update({
    where: { id },
    data: { status: "PENDING", attemptCount, failureReason },
  });
}

export function startNotificationDispatcher(
  providers: Record<string, NotificationProvider>,
  intervalMs = 3000,
): NodeJS.Timeout {
  return setInterval(() => {
    processOneNotification(providers).catch((err) => {
      console.error("[notifications] unexpected error dispatching notification", err);
    });
  }, intervalMs);
}
