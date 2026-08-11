import { prisma } from "@support-automation/db";
import type { OutboundMessage } from "@prisma/client";
import type { WhatsAppProvider } from "../provider/WhatsAppProvider.js";
import { isCooldownActive } from "./cooldown.js";
import { getGlobalRateLimitUsage, getPerClientLimitUsage } from "./rateLimiter.js";
import { getAutomationSettings } from "../pipeline/settings.js";
import {
  countJobSentLastMinute,
  getGroupBroadcastSettings,
  markJobStartedIfNeeded,
  markJobStoppedByKillSwitch,
  maybeCompleteBroadcastJob,
} from "./groupBroadcastQueue.js";

const STUCK_PROCESSING_TIMEOUT_MS = 2 * 60_000;
/** How long to defer a GROUP_BROADCAST row when its job's own per-minute cap is hit — not a failure, just a wait. */
const JOB_RATE_LIMIT_DEFER_MS = 15_000;

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

/**
 * GROUP_BROADCAST-only pre-send gate: the job may have been stopped (by a
 * user or the kill switch) after this row was scheduled, or the job's own
 * per-minute cap may already be exhausted by other rows sent since this one
 * was queued. Returns "STOP_TICK" if processOne should end its turn here
 * without attempting a send (the row's own status has already been updated
 * as appropriate), or "CONTINUE" to proceed with the normal send path.
 */
async function handleBroadcastPreSendChecks(message: OutboundMessage): Promise<"STOP_TICK" | "CONTINUE"> {
  const jobId = message.broadcastJobId!;
  const job = await prisma.groupBroadcastJob.findUnique({
    where: { id: jobId },
    select: { status: true, maxPerMinute: true },
  });

  if (!job || job.status === "CANCELLED" || job.status === "STOPPED_KILL_SWITCH") {
    await prisma.outboundMessage.update({
      where: { id: message.id },
      data: { status: "CANCELLED", failureReason: "The broadcast job was stopped before this message could be sent." },
    });
    await maybeCompleteBroadcastJob(jobId);
    return "STOP_TICK";
  }

  const sentLastMinute = await countJobSentLastMinute(jobId);
  if (sentLastMinute >= job.maxPerMinute) {
    // Defer, not a failure: leave PENDING and try again shortly once the per-minute window clears.
    // This is the "PAUSE the job, do not silently continue" behavior from the safety requirement —
    // no further sends happen for this job until the window allows one.
    // claimNextOutboundMessage() already flipped this row to PROCESSING — release it back to PENDING,
    // otherwise it would sit unreclaimed until the (much longer) stuck-PROCESSING crash-recovery timeout.
    await prisma.outboundMessage.update({
      where: { id: message.id },
      data: { status: "PENDING", scheduledAt: new Date(Date.now() + JOB_RATE_LIMIT_DEFER_MS) },
    });
    return "STOP_TICK";
  }

  return "CONTINUE";
}

/** Exported for direct testing — drains exactly one due message, or returns false if none are ready. */
export async function processOne(provider: WhatsAppProvider): Promise<boolean> {
  const message = await claimNextOutboundMessage();
  if (!message) return false;

  const isBroadcast = message.actionType === "GROUP_BROADCAST" && Boolean(message.broadcastJobId);
  const settings = await getAutomationSettings();

  if (!settings.automationEnabled) {
    await prisma.outboundMessage.update({
      where: { id: message.id },
      data: { status: "CANCELLED", failureReason: "Automation was paused before this message could be sent." },
    });
    // The kill switch must "immediately stop queued outbound group sending" — stamping the job here means every
    // other still-PENDING row belonging to it is caught by the isJobStopped-equivalent check below on its own turn,
    // and the dashboard can show "STOPPED BY KILL SWITCH" without waiting for each row to be claimed one at a time.
    if (isBroadcast) {
      await markJobStoppedByKillSwitch(message.broadcastJobId!);
      await maybeCompleteBroadcastJob(message.broadcastJobId!);
    }
    return true;
  }

  if (isBroadcast) {
    const stopped = await handleBroadcastPreSendChecks(message);
    if (stopped === "STOP_TICK") return true;
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

  if (isBroadcast) {
    await markJobStartedIfNeeded(message.broadcastJobId!);
    // Never send blindly: a live, single-chat check right before sending, not just reliance on
    // the (possibly stale) synchronized WhatsAppGroup table used at job-creation/preview time.
    const isMember = await provider.verifyGroupMembership(message.chatId);
    if (!isMember) {
      await prisma.outboundMessage.update({
        where: { id: message.id },
        data: { status: "SKIPPED", failureReason: "Membership could not be verified." },
      });
      await maybeCompleteBroadcastJob(message.broadcastJobId!);
      return true;
    }
  }

  try {
    const result = await provider.sendMessage(message.chatId, message.body);
    if (result.success) {
      await prisma.outboundMessage.update({
        where: { id: message.id },
        data: {
          status: "SENT",
          sentAt: new Date(),
          attemptCount: { increment: 1 },
          providerMessageId: result.providerMessageId ?? undefined,
        },
      });
      if (isBroadcast) await maybeCompleteBroadcastJob(message.broadcastJobId!);
    } else {
      await handleSendFailure(message, result.error ?? "Unknown provider error");
    }
  } catch (err) {
    await handleSendFailure(message, (err as Error).message);
  }
  return true;
}

async function handleSendFailure(message: OutboundMessage, failureReason: string): Promise<void> {
  const attemptCount = message.attemptCount + 1;
  const isBroadcast = message.actionType === "GROUP_BROADCAST" && Boolean(message.broadcastJobId);
  const maxAttempts = isBroadcast
    ? (await getGroupBroadcastSettings()).retryMaxAttempts
    : (await getAutomationSettings()).retryMaxAttempts;

  if (attemptCount >= maxAttempts) {
    await prisma.outboundMessage.update({
      where: { id: message.id },
      data: { status: "FAILED", attemptCount, failureReason },
    });
    if (isBroadcast) await maybeCompleteBroadcastJob(message.broadcastJobId!);
    return;
  }
  const delayMs = await computeNextRetryDelayMs(attemptCount);
  await prisma.outboundMessage.update({
    where: { id: message.id },
    data: {
      status: "PENDING",
      attemptCount,
      failureReason,
      scheduledAt: new Date(Date.now() + delayMs),
    },
  });
}

/**
 * Starts the periodic drain loop. Processes at most one message per tick to avoid sending bursts.
 * Same overlap guard as startCommandProcessor (ENGINEERING_STANDARDS.md §9/§15 "no concurrent
 * duplicate workers"): plain setInterval doesn't wait for the previous tick's promise, so a slow
 * send (provider timeout, retry backoff wait) could otherwise let a second tick claim and process
 * another row concurrently with the first.
 */
export function startOutboundQueueProcessor(
  provider: WhatsAppProvider,
  intervalMs = 2000,
): NodeJS.Timeout {
  let processing = false;
  return setInterval(() => {
    if (processing) return;
    processing = true;
    processOne(provider)
      .catch((err) => {
        console.error("[queue] unexpected error processing outbound message", err);
      })
      .finally(() => {
        processing = false;
      });
  }, intervalMs);
}
