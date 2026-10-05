import { countMetric } from "../health/metrics.js";
import { trackTick } from "../lifecycle.js";
import { platformPrisma, prisma } from "../db.js";
import { currentProjectId, OPERATING_PROJECT_STATUSES, projectIdForAccount, withProject } from "../project/context.js";
import type { OutboundMessage } from "@prisma/client";
import type { WhatsAppProvider } from "../provider/WhatsAppProvider.js";
import { isCooldownActive } from "./cooldown.js";
import { MOOD_CUSTOMER_MESSAGE_VARIANT } from "@support-automation/shared";
import { exceedsLimit, getGlobalRateLimitUsage, getPerClientLimitUsage } from "./rateLimiter.js";
import { getAutomationSettings } from "../pipeline/settings.js";
import { getAiSettings } from "../ai/settings.js";
import { logSystemEvent } from "../logging/logSystemEvent.js";
import {
  countJobSentLastMinute,
  getGroupBroadcastSettings,
  markJobStartedIfNeeded,
  markJobStoppedByKillSwitch,
  maybeCompleteBroadcastJob,
} from "./groupBroadcastQueue.js";
import { recordLoopTick, registerLoop } from "../health/loopLiveness.js";

/** Name this loop reports itself under in the per-loop liveness view. */
const LOOP_NAME = "outbound-queue";

/**
 * How long a claimed outbound row may sit PROCESSING before recovery pushes it back to PENDING.
 *
 * Two minutes was SHORTER than Puppeteer's own 180s `protocolTimeout`, which is the ceiling on how
 * long a single `sendText` can hang before the browser gives up. So a send that was still
 * genuinely in flight could be requeued underneath itself, and then sent again when the first one
 * eventually completed — a customer receiving the same reply twice, which is precisely the outcome
 * the shutdown handling and the idempotency key exist to prevent.
 *
 * Five minutes clears that ceiling with room for the surrounding safety checks and the status
 * settle. Erring long costs a stuck row a few more minutes; erring short costs a duplicate message
 * in a customer's conversation.
 */
const STUCK_PROCESSING_TIMEOUT_MS = 5 * 60_000;
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
  // Install-wide on purpose: releases this worker's own stranded claims, status only.
  const result = await platformPrisma.outboundMessage.updateMany({
    where: { status: "PROCESSING", updatedAt: { lt: cutoff } },
    data: { status: "PENDING" },
  });
  return result.count;
}

/**
 * Atomically claims exactly one due PENDING row, or null if none are ready.
 *
 * The queue is shared by every project and drained in one global order — one send per tick, exactly
 * as before projects existed — so the claim reads across projects (`platformPrisma`). Everything
 * after it runs inside the claimed row's own project (`withProject(row.projectId)`), which is the
 * project that created it; `processClaimedMessage` then refuses to send through an account that
 * belongs to any other project.
 */
async function claimNextOutboundMessage() {
  const candidate = await platformPrisma.outboundMessage.findFirst({
    // A suspended or archived project's rows are HELD — left PENDING, never cancelled (§8).
    where: { status: "PENDING", scheduledAt: { lte: new Date() }, project: { status: { in: [...OPERATING_PROJECT_STATUSES] } } },
    orderBy: { scheduledAt: "asc" },
  });
  if (!candidate) return null;

  const claim = await platformPrisma.outboundMessage.updateMany({
    where: { id: candidate.id, status: "PENDING" },
    data: { status: "PROCESSING", lastAttemptAt: new Date() },
  });
  if (claim.count === 0) return null; // lost the race (shouldn't happen with a single worker, but defensive)

  return platformPrisma.outboundMessage.findUniqueOrThrow({ where: { id: candidate.id } });
}

/**
 * The outbound safety check (MULTI_PROJECT_PLAN.md Phase 3): the account a row would be sent from
 * must belong to the project that created the row. A mismatch — only reachable through corrupted or
 * forged data, since every writer stamps both from one project — is failed, logged and never sent:
 * sending one project's words from another project's WhatsApp number is the one cross-project leak
 * a customer would actually see. A missing account fails the same way rather than guessing.
 */
async function outboundAccountBelongsToProject(message: OutboundMessage): Promise<boolean> {
  let accountProjectId: string | null = null;
  try {
    accountProjectId = await projectIdForAccount(message.accountId);
  } catch {
    accountProjectId = null;
  }
  if (accountProjectId === currentProjectId()) return true;

  await prisma.outboundMessage.update({
    where: { id: message.id },
    data: {
      status: "FAILED",
      failureReason: accountProjectId
        ? "The sending WhatsApp account belongs to a different project, so the message was not sent."
        : "The sending WhatsApp account no longer exists, so the message was not sent.",
    },
  });
  await logSystemEvent("ERROR", "queue", "Refused to send a message through an account outside its project", {
    outboundMessageId: message.id,
    accountId: message.accountId,
    messageProjectId: message.projectId,
    accountProjectId,
  }).catch(() => undefined);
  return false;
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
  await withProject(message.projectId, () => processClaimedMessage(message, provider));
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

  await withProject(message.projectId, async () => {
    if (!(await outboundAccountBelongsToProject(message))) return;
    const provider = registry.get(message.accountId);
    if (!provider) {
      // Release back to PENDING rather than fail — no send was attempted, so this must not count
      // against attemptCount/retry budget.
      await prisma.outboundMessage.update({
        where: { id: message.id },
        data: { status: "PENDING", scheduledAt: new Date(Date.now() + ACCOUNT_NOT_READY_DEFER_MS) },
      });
      return;
    }
    await processClaimedMessage(message, provider);
  });
  return true;
}

async function processClaimedMessage(message: OutboundMessage, provider: WhatsAppProvider): Promise<void> {
  // Checked again here (cached lookup) so the injected-provider path is covered too.
  if (!(await outboundAccountBelongsToProject(message))) return;
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
    // A limit of 0 means ZERO SENDS ALLOWED, not "unlimited" — see exceedsLimit() in
    // rateLimiter.ts, which spells out why that literal reading is the one kept. Shared with the
    // enqueue-time gate in pipeline/safety.ts so the two cannot disagree. Turning limits off is
    // `rateLimitingEnabled` above; it is never a zero.
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

  // The cooldown re-check, for BOTH kinds of cooled-down reply.
  //
  // This used to be `if (message.ruleId)` and nothing else — so it never ran for an AI reply,
  // which is rule-less by construction (`ruleId: null`, see runAiFallback). The enqueue-time check
  // in safety.ts was therefore the only one, and it is a read-then-write: two messages from one
  // customer processed concurrently both look at the window before either has inserted, both see
  // it empty, and both queue a reply under legitimately different idempotency keys. Nothing
  // downstream looked at them again, so the customer got two AI answers inside a five-minute
  // cooldown.
  //
  // Deliberately NOT applied to every rule-less row. MANUAL_REPLY is rule-less too, and an AI
  // cooldown must never hold back something a person typed — the switch stops the robot, not the
  // operator. GROUP_BROADCAST is rule-less and has its own pacing. So this is narrowed to exactly
  // what the AI fallback produces: an AUTO_REPLY with no rule behind it.
  const cooldownSeconds = message.ruleId
    ? (await prisma.automationRule.findUnique({ where: { id: message.ruleId }, select: { cooldownSeconds: true } }))
        ?.cooldownSeconds ?? null
    : message.actionType === "AUTO_REPLY" && !message.idempotencyKey.endsWith(`:${MOOD_CUSTOMER_MESSAGE_VARIANT}`)
      ? (await getAiSettings()).aiReplyCooldownSeconds
      : null;
  // (Mood Detection's message to an upset customer is excluded: it is sent once per mood alert
  // BECAUSE a person is needed, so an AI answer moments earlier must not cancel it on the way out.
  // Kill switch, MANUAL_ONLY, rate limits and membership are all still checked.)

  // Test mode lifts cooldowns at enqueue time (safety.ts); it has to lift them here too, or an
  // approved test group could queue a reply and then have it cancelled on the way out.
  if (cooldownSeconds && cooldownSeconds > 0 && !inTestMode) {
    const cooling = await isCooldownActive({
      accountId: message.accountId,
      toPhone: message.toPhone,
      ruleId: message.ruleId,
      cooldownSeconds,
      // Without this the claim that just flipped THIS row to PROCESSING is itself found by the
      // lookup, and every send reports its own cooldown. See isCooldownActive's own doc comment.
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
    // This file did not import logSystemEvent at all, so every message this system permanently
    // failed to deliver was console-only — visible in `docker compose logs` if somebody thought to
    // look, and absent from the Logs page that is the actual place people look. A customer who was
    // never answered is exactly the event the durable log exists for.
    await logSystemEvent("ERROR", "queue", "Gave up sending a message after every retry", {
      outboundMessageId: message.id,
      accountId: message.accountId,
      actionType: message.actionType,
      attemptCount,
      failureReason,
    }).catch(() => undefined);
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
    void trackTick(() => processOneViaRegistry(registry))
      .catch((err) => {
        console.error("[queue] unexpected error processing outbound message", err);
      })
      .finally(() => {
        processing = false;
        // Stamped when the tick FINISHES, which is the only moment that proves the loop is not
        // wedged — a guard that never clears is exactly how one of these dies silently.
        recordLoopTick(LOOP_NAME, intervalMs);
      });
  }, intervalMs);
}
