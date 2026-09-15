import { countMetric } from "../health/metrics.js";
import { trackTick } from "../lifecycle.js";
import { prisma } from "@support-automation/db";
import type { OutboundMessage } from "@prisma/client";
import type { WhatsAppProvider } from "../provider/WhatsAppProvider.js";
import { isCooldownActive } from "./cooldown.js";
import { exceedsLimit, getGlobalRateLimitUsage, getPerClientLimitUsage } from "./rateLimiter.js";
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
/** How long to defer a human's MANUAL_REPLY when an account rate limit is already exhausted. */
const MANUAL_RATE_LIMIT_DEFER_MS = 20_000;
/** How long to hold an auto-reply that hit an account limit before trying again. */
const RATE_LIMIT_DEFER_MS = 30_000;
/**
 * How many times an auto-reply may be deferred for rate limits before it is abandoned. Roughly
 * ten minutes of waiting: long enough to ride out a genuine burst, short enough that a customer
 * is not answered so late the reply is confusing.
 */
const MAX_RATE_LIMIT_DEFERRALS = 20;

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

/**
 * The AI reply cooldown that applies to this queued row, or null when the AI cooldown is not the
 * right rule for it.
 *
 * Returns a value only for a rule-less AUTO_REPLY carrying no mentions — which is precisely the
 * shape the AI fallback enqueues. Two exclusions are load-bearing:
 *
 *  - A row with a `ruleId` is governed by its own rule's cooldown, handled by the caller.
 *  - A row with `mentions` is the handover mention ("@Rakib, please help"), which the AI fallback
 *    also enqueues as a rule-less AUTO_REPLY and therefore shares this cooldown bucket with. It
 *    must NOT be cancelled by a preceding AI answer: it is a request for a human, not a second
 *    attempt to answer, and silently dropping it would leave a customer waiting with nobody told.
 */
async function resolveAiCooldownForMessage(message: {
  ruleId: string | null;
  actionType: string;
  mentions: string[];
}): Promise<number | null> {
  if (message.ruleId !== null) return null;
  if (message.actionType !== "AUTO_REPLY") return null;
  if (message.mentions.length > 0) return null;

  const aiSettings = await prisma.aiSettings.findUnique({
    where: { id: "global" },
    select: { aiReplyCooldownSeconds: true },
  });
  return aiSettings?.aiReplyCooldownSeconds ?? null;
}

/**
 * Whether this queued send belongs to a group an admin marked as a test group.
 *
 * Resolved through `relatedMessage.groupId` — the conversation this is a reply to — with
 * `OutboundMessage.groupId` as the fallback for the broadcast path, which is the only path that
 * sets it.
 */
async function isTestModeSend(message: OutboundMessage): Promise<boolean> {
  if (message.relatedMessageId) {
    const related = await prisma.message.findUnique({
      where: { id: message.relatedMessageId },
      select: { group: { select: { testModeEnabled: true } } },
    });
    if (related?.group) return related.group.testModeEnabled;
  }
  if (message.groupId) {
    const group = await prisma.whatsAppGroup.findUnique({
      where: { id: message.groupId },
      select: { testModeEnabled: true },
    });
    return group?.testModeEnabled ?? false;
  }
  return false;
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
  await processClaimedMessage(message, provider);
  return true;
}

/** How long to defer a message whose account isn't connected in this worker yet — not a failure, just a wait (e.g. sequential startup still connecting a later account). */
const ACCOUNT_NOT_READY_DEFER_MS = 30_000;

/**
 * Multi-account entry point: claims exactly once, resolves which account's provider to send
 * through from the claimed message's own `accountId` (never an injected single instance
 * anymore), then shares the exact same send logic via `processClaimedMessage`.
 */
export async function processOneViaRegistry(registry: import("../provider/ProviderRegistry.js").ProviderRegistry): Promise<boolean> {
  const message = await claimNextOutboundMessage();
  if (!message) return false;

  const provider = registry.get(message.accountId);
  if (!provider) {
    // Release back to PENDING rather than fail — no send was attempted, so this must not count
    // against attemptCount/retry budget.
    await prisma.outboundMessage.update({
      where: { id: message.id },
      data: { status: "PENDING", scheduledAt: new Date(Date.now() + ACCOUNT_NOT_READY_DEFER_MS) },
    });
    return true;
  }

  await processClaimedMessage(message, provider);
  return true;
}

async function processClaimedMessage(message: OutboundMessage, provider: WhatsAppProvider): Promise<void> {
  const isBroadcast = message.actionType === "GROUP_BROADCAST" && Boolean(message.broadcastJobId);
  // A person typed this in the WhatsApp Chat inbox and pressed send. It rides the same single
  // outbound queue as everything else — there is still exactly one send path — but two of the
  // queue's automation-shaped behaviours do not apply to it, below.
  const isManualReply = message.actionType === "MANUAL_REPLY";
  const settings = await getAutomationSettings();

  // The kill switch pauses automation. It is not a WhatsApp-wide send freeze, and cancelling an
  // operator's own typed message because the robot is paused would be both surprising and, in the
  // middle of an incident, exactly backwards — pausing automation is usually *why* a human has
  // stepped in to reply by hand.
  if (!settings.automationEnabled && !isManualReply) {
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
    return;
  }

  if (isBroadcast) {
    const stopped = await handleBroadcastPreSendChecks(message);
    if (stopped === "STOP_TICK") return;
  }

  // Same test-group exemption the pre-send gate applies (pipeline/safety.ts). Re-read here rather
  // than trusted from queue time, because a group can be taken out of test mode while a message
  // sits in the queue.
  //
  // The group is resolved through the message this is a reply TO. OutboundMessage.groupId is
  // deliberately null for automation-generated rows — it belongs to the broadcast path, which
  // addresses a group directly — so reading it here found nothing and every test-group reply was
  // still rate limited. That is what the send-time check got wrong the first time.
  const inTestMode = await isTestModeSend(message);

  if (settings.rateLimitingEnabled && !inTestMode) {
    const [global, perClient] = await Promise.all([
      getGlobalRateLimitUsage(message.accountId),
      getPerClientLimitUsage(message.accountId, message.toPhone),
    ]);
    // A limit of 0 means no limit — see exceedsLimit() in rateLimiter.ts. Shared with the
    // enqueue-time gate in pipeline/safety.ts so the two cannot disagree.
    const limitExceeded =
      exceedsLimit(global.perMinute, settings.globalMaxPerMinute) ||
      exceedsLimit(global.perHour, settings.globalMaxPerHour) ||
      exceedsLimit(global.perDay, settings.globalMaxPerDay) ||
      exceedsLimit(perClient.perHour, settings.maxRepliesPerClientPerHour) ||
      exceedsLimit(perClient.perDay, settings.maxRepliesPerClientPerDay);

    if (limitExceeded) {
      if (isManualReply) {
        // Account rate limits exist to protect the WhatsApp number, so they still bind a manual
        // reply — but RATE_LIMITED is terminal, and silently discarding something a person wrote
        // is not acceptable. Defer instead and let it send once the window clears.
        await prisma.outboundMessage.update({
          where: { id: message.id },
          data: {
            status: "PENDING",
            scheduledAt: new Date(Date.now() + MANUAL_RATE_LIMIT_DEFER_MS),
            failureReason: "Waiting for the account rate-limit window to clear.",
          },
        });
        return;
      }
      // An auto-reply answers a question a customer actually asked — every row this path produces
      // is triggered by an incoming message, never sent unprompted. Discarding it means that
      // customer is simply never answered, which is a worse outcome than answering late and is
      // not what a rate limit is for. So it defers, like a manual reply, up to a bounded number of
      // attempts before giving up for real.
      if (!isBroadcast && message.attemptCount < MAX_RATE_LIMIT_DEFERRALS) {
        await prisma.outboundMessage.update({
          where: { id: message.id },
          data: {
            status: "PENDING",
            attemptCount: { increment: 1 },
            scheduledAt: new Date(Date.now() + RATE_LIMIT_DEFER_MS),
            failureReason: "Waiting for the account rate-limit window to clear.",
          },
        });
        return;
      }

      await prisma.outboundMessage.update({
        where: { id: message.id },
        data: { status: "RATE_LIMITED", failureReason: "Rate or per-client limit reached at send time." },
      });
      // RATE_LIMITED is terminal — the row is never reclaimed — so this path has to settle the job
      // like every other terminal one. Without it a broadcast whose last row hit an account limit
      // sat RUNNING forever.
      if (isBroadcast) await maybeCompleteBroadcastJob(message.broadcastJobId!);
      return;
    }
  }

  // The send-time cooldown re-check, for rule replies AND for AI replies.
  //
  // It used to be gated on `message.ruleId`, which every AI reply leaves null — so the AI path
  // had the enqueue-time check and no re-check at all, while the rule path had both. That gap is
  // what let a customer receive two AI answers inside one cooldown window: message processing is
  // fire-and-forget and unserialised, so two questions arriving seconds apart produce two
  // pipelines that both read the cooldown as clear before either has enqueued anything. Their
  // idempotency keys differ (different incomingMessageId), so the unique constraint does not
  // apply — the same QUESTION answered twice is already impossible, two questions in the window
  // was not.
  //
  // The queue is the serialisation point that closes it: it claims one row per tick, strictly
  // serially, so by the time the second row is claimed the first is already PENDING/SENT and
  // visible to isCooldownActive.
  const aiReplyCooldownSeconds = inTestMode ? null : await resolveAiCooldownForMessage(message);
  if (message.ruleId || aiReplyCooldownSeconds !== null) {
    const cooldownSeconds =
      message.ruleId === null
        ? aiReplyCooldownSeconds
        : (
            await prisma.automationRule.findUnique({
              where: { id: message.ruleId },
              select: { cooldownSeconds: true },
            })
          )?.cooldownSeconds ?? null;

    if (cooldownSeconds) {
      const cooling = await isCooldownActive({
        accountId: message.accountId,
        toPhone: message.toPhone,
        ruleId: message.ruleId,
        cooldownSeconds,
        excludeOutboundMessageId: message.id,
      });
      if (cooling) {
        await prisma.outboundMessage.update({
          where: { id: message.id },
          data: { status: "CANCELLED", failureReason: "Cooldown became active before this message could be sent." },
        });
        return;
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
      return;
    }
  }

  if (isManualReply) {
    // Same live membership check the broadcast path does, for the same reason: the group list the
    // inbox rendered from can be minutes stale, and sending into a group this account has been
    // removed from is an error worth reporting rather than a silent provider failure.
    const isMember = await provider.verifyGroupMembership(message.chatId);
    if (!isMember) {
      await prisma.outboundMessage.update({
        where: { id: message.id },
        data: {
          status: "SKIPPED",
          failureReason: "This account is no longer a member of the group, so the message was not sent.",
        },
      });
      return;
    }
  }

  try {
    const result = await provider.sendMessage(message.chatId, message.body, message.mentions);
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
      countMetric("replied");
      if (isBroadcast) await maybeCompleteBroadcastJob(message.broadcastJobId!);
    } else {
      await handleSendFailure(message, result.error ?? "Unknown provider error");
    }
  } catch (err) {
    await handleSendFailure(message, (err as Error).message);
  }
  return;
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
  registry: import("../provider/ProviderRegistry.js").ProviderRegistry,
  intervalMs = 2000,
): NodeJS.Timeout {
  let processing = false;
  return setInterval(() => {
    if (processing) return;
    processing = true;
    // Wrapped so shutdown can wait for a claim already in flight and refuse to start a new one.
    // Without it, SIGTERM during this tick killed the process mid-work and left the claimed row
    // PROCESSING until the next boot requeued and re-ran it — see lifecycle.ts.
    void trackTick(() => processOneViaRegistry(registry))
      .catch((err) => {
        console.error("[queue] unexpected error processing outbound message", err);
      })
      .finally(() => {
        processing = false;
      });
  }, intervalMs);
}
