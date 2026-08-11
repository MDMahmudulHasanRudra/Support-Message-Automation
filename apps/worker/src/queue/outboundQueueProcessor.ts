import { prisma } from "@support-automation/db";
import type { WhatsAppProvider } from "../provider/WhatsAppProvider.js";
import { isCooldownActive } from "./cooldown.js";
import { getGlobalRateLimitUsage, getPerClientLimitUsage } from "./rateLimiter.js";
import { getAutomationSettings } from "../pipeline/settings.js";

const STUCK_PROCESSING_TIMEOUT_MS = 2 * 60_000;

/** Crash recovery: rows left in PROCESSING by a worker that died mid-send go back to PENDING. */
export async function recoverStuckOutboundMessages(): Promise<number> {
  const cutoff = new Date(Date.now() - STUCK_PROCESSING_TIMEOUT_MS);
  const result = await prisma.outboundMessage.updateMany({
    where: { status: "PROCESSING", updatedAt: { lt: cutoff } },
    data: { status: "PENDING" },
  });
  return result.count;
}

/** Atomically claims exactly one due PENDING row, or null if none are ready. */
async function claimNextOutboundMessage() {
  const candidate = await prisma.outboundMessage.findFirst({
    where: { status: "PENDING", scheduledAt: { lte: new Date() } },
    orderBy: { scheduledAt: "asc" },
  });
  if (!candidate) return null;

  const claim = await prisma.outboundMessage.updateMany({
    where: { id: candidate.id, status: "PENDING" },
    data: { status: "PROCESSING", lastAttemptAt: new Date() },
  });
  if (claim.count === 0) return null; // lost the race (shouldn't happen with a single worker, but defensive)

  return prisma.outboundMessage.findUniqueOrThrow({ where: { id: candidate.id } });
}

async function computeNextRetryDelayMs(attemptCount: number): Promise<number> {
  const settings = await getAutomationSettings();
  const intervals = Array.isArray(settings.retryIntervalsMs)
    ? (settings.retryIntervalsMs as number[])
    : [30_000, 300_000, 900_000];
  return intervals[Math.min(attemptCount - 1, intervals.length - 1)] ?? 900_000;
}

/** Exported for direct testing — drains exactly one due message, or returns false if none are ready. */
export async function processOne(provider: WhatsAppProvider): Promise<boolean> {
  const message = await claimNextOutboundMessage();
  if (!message) return false;

  const settings = await getAutomationSettings();

  if (!settings.automationEnabled) {
    await prisma.outboundMessage.update({
      where: { id: message.id },
      data: { status: "CANCELLED", failureReason: "Automation was paused before this message could be sent." },
    });
    return true;
  }

  if (settings.rateLimitingEnabled) {
    const [global, perClient] = await Promise.all([
      getGlobalRateLimitUsage(message.accountId),
      getPerClientLimitUsage(message.accountId, message.toPhone),
    ]);
    const limitExceeded =
      global.perMinute >= settings.globalMaxPerMinute ||
      global.perHour >= settings.globalMaxPerHour ||
      global.perDay >= settings.globalMaxPerDay ||
      perClient.perHour >= settings.maxRepliesPerClientPerHour ||
      perClient.perDay >= settings.maxRepliesPerClientPerDay;

    if (limitExceeded) {
      await prisma.outboundMessage.update({
        where: { id: message.id },
        data: { status: "RATE_LIMITED", failureReason: "Rate or per-client limit reached at send time." },
      });
      return true;
    }
  }

  if (message.ruleId) {
    const rule = await prisma.automationRule.findUnique({
      where: { id: message.ruleId },
      select: { cooldownSeconds: true },
    });
    if (rule?.cooldownSeconds) {
      const cooling = await isCooldownActive({
        accountId: message.accountId,
        toPhone: message.toPhone,
        ruleId: message.ruleId,
        cooldownSeconds: rule.cooldownSeconds,
        excludeOutboundMessageId: message.id,
      });
      if (cooling) {
        await prisma.outboundMessage.update({
          where: { id: message.id },
          data: { status: "CANCELLED", failureReason: "Cooldown became active before this message could be sent." },
        });
        return true;
      }
    }
  }

  try {
    const result = await provider.sendMessage(message.chatId, message.body);
    if (result.success) {
      await prisma.outboundMessage.update({
        where: { id: message.id },
        data: { status: "SENT", sentAt: new Date(), attemptCount: { increment: 1 } },
      });
    } else {
      await handleSendFailure(message.id, message.attemptCount + 1, result.error ?? "Unknown provider error");
    }
  } catch (err) {
    await handleSendFailure(message.id, message.attemptCount + 1, (err as Error).message);
  }
  return true;
}

async function handleSendFailure(id: string, attemptCount: number, failureReason: string): Promise<void> {
  const settings = await getAutomationSettings();
  if (attemptCount >= settings.retryMaxAttempts) {
    await prisma.outboundMessage.update({
      where: { id },
      data: { status: "FAILED", attemptCount, failureReason },
    });
    return;
  }
  const delayMs = await computeNextRetryDelayMs(attemptCount);
  await prisma.outboundMessage.update({
    where: { id },
    data: {
      status: "PENDING",
      attemptCount,
      failureReason,
      scheduledAt: new Date(Date.now() + delayMs),
    },
  });
}

/** Starts the periodic drain loop. Processes at most one message per tick to avoid sending bursts. */
export function startOutboundQueueProcessor(
  provider: WhatsAppProvider,
  intervalMs = 2000,
): NodeJS.Timeout {
  return setInterval(() => {
    processOne(provider).catch((err) => {
      console.error("[queue] unexpected error processing outbound message", err);
    });
  }, intervalMs);
}
