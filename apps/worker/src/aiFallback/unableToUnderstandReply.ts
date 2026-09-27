import { prisma } from "@support-automation/db";
import {
  isAcknowledgementOnly,
  isUnableToUnderstandReason,
  resolveUnableToUnderstandReply,
  UNABLE_TO_UNDERSTAND_VARIANT,
} from "@support-automation/shared";
import type { AiSettings, AutomationSettings } from "@prisma/client";
import { logSystemEvent } from "../logging/logSystemEvent.js";
import { enqueueOutboundMessage } from "../pipeline/enqueueOutbound.js";
import { checkAutoReplySafety } from "../pipeline/safety.js";

/**
 * The customer-facing half of a handover: "we could not understand this, the support team will
 * follow up". Sent only when `AiSettings.unableToUnderstandReplyEnabled` is on and the handover
 * reason means the AI had no reliable answer (`isUnableToUnderstandReason` — never a throttle, an
 * outage or a malformed response).
 *
 * Not a second send path: it goes through `enqueueOutboundMessage` like every reply, so the queue's
 * send-time checks (membership, kill switch, rate limits) still apply. Before queuing it re-runs
 * `checkAutoReplySafety` WITHOUT the AI reply cooldown — the pipeline's own pre-check already
 * applied that, and this is not an answer — so the kill switch, MANUAL_ONLY, the monitored-group
 * requirement and the rate limits protecting the number all still decide.
 *
 * Three guards against repeating it:
 *   - the caller runs this only on the pass that claimed the AiFallbackDecision row, so a re-run
 *     of a stranded message cannot send twice;
 *   - its own idempotency variant makes a second row for the same customer message impossible;
 *   - `unableToUnderstandRepeatMinutes` stops a burst of unclear messages in one conversation
 *     producing one holding reply each.
 *
 * Never throws. The team has already been alerted by the time this runs, and failing to also tell
 * the customer must not undo the handover.
 */
export async function sendUnableToUnderstandReply(params: {
  reason: string;
  aiSettings: Pick<AiSettings, "unableToUnderstandReplyEnabled" | "unableToUnderstandReplyText" | "unableToUnderstandRepeatMinutes">;
  automationSettings: AutomationSettings;
  accountId: string;
  groupId: string | null;
  chatId: string;
  toPhone: string;
  incomingMessageId: string;
  /** The customer's text, to recognise a plain "ok"/"thanks" that needs no holding reply. */
  messageBody: string;
  testMode: boolean;
  correlationId?: string | null;
}): Promise<string | null> {
  if (!params.aiSettings.unableToUnderstandReplyEnabled) return null;
  if (!isUnableToUnderstandReason(params.reason)) return null;

  const skip = async (why: string) => {
    await logSystemEvent(
      "INFO",
      "ai-fallback",
      "AI_UNABLE_TO_UNDERSTAND_REPLY_SKIPPED",
      { reason: why, handoverReason: params.reason, accountId: params.accountId },
      { targetType: "Message", targetId: params.incomingMessageId, correlationId: params.correlationId ?? null },
    );
    return null;
  };

  // "ok vai", "ধন্যবাদ", a thumbs-up: nothing was asked, so "sorry, I did not understand" would be
  // wrong. Under the default strict mode every one of these is a NO_KNOWLEDGE handover. A media-only
  // message is exempt: its body is a placeholder, and not being able to see an image IS the case.
  if (params.reason !== "MEDIA_ONLY_MESSAGE" && isAcknowledgementOnly(params.messageBody)) {
    return skip("the message is only an acknowledgement or greeting");
  }

  try {
    if (await sentRecently(params.accountId, params.chatId, params.aiSettings.unableToUnderstandRepeatMinutes, params.testMode)) {
      return skip(`already sent in this conversation within ${params.aiSettings.unableToUnderstandRepeatMinutes} minutes`);
    }

    const safety = await checkAutoReplySafety({
      accountId: params.accountId,
      toPhone: params.toPhone,
      groupId: params.groupId,
      rule: null,
      cooldownSeconds: null,
      settings: params.automationSettings,
    });
    if (!safety.allowed) return skip(safety.reason);

    const { queued, outboundMessageId } = await enqueueOutboundMessage({
      accountId: params.accountId,
      chatId: params.chatId,
      toPhone: params.toPhone,
      body: resolveUnableToUnderstandReply(params.aiSettings.unableToUnderstandReplyText),
      incomingMessageId: params.incomingMessageId,
      ruleId: null,
      actionType: "AUTO_REPLY",
      settings: params.automationSettings,
      testMode: params.testMode,
      idempotencyVariant: UNABLE_TO_UNDERSTAND_VARIANT,
    });
    if (!queued || !outboundMessageId) return skip("already queued for this message");

    await logSystemEvent(
      "INFO",
      "ai-fallback",
      "AI_UNABLE_TO_UNDERSTAND_REPLY_QUEUED",
      { handoverReason: params.reason, accountId: params.accountId, outboundMessageId },
      { targetType: "Message", targetId: params.incomingMessageId, correlationId: params.correlationId ?? null },
    );
    return outboundMessageId;
  } catch (err) {
    await logSystemEvent(
      "WARN",
      "ai-fallback",
      "AI_UNABLE_TO_UNDERSTAND_REPLY_FAILED",
      { error: (err as Error).message, handoverReason: params.reason, accountId: params.accountId },
      { targetType: "Message", targetId: params.incomingMessageId, correlationId: params.correlationId ?? null },
    );
    return null;
  }
}

/**
 * Whether a holding reply already went to this conversation inside the repeat window. Counts queued
 * rows as well as sent ones — a burst arrives faster than the queue drains. A test group is exempt,
 * like every other throttle, so the reply can be exercised back to back.
 */
async function sentRecently(accountId: string, chatId: string, minutes: number, testMode: boolean): Promise<boolean> {
  if (testMode || minutes <= 0) return false;
  const recent = await prisma.outboundMessage.findFirst({
    where: {
      accountId,
      chatId,
      idempotencyKey: { endsWith: `:${UNABLE_TO_UNDERSTAND_VARIANT}` },
      status: { in: ["PENDING", "PROCESSING", "SENT"] },
      createdAt: { gte: new Date(Date.now() - minutes * 60_000) },
    },
    select: { id: true },
  });
  return recent !== null;
}
