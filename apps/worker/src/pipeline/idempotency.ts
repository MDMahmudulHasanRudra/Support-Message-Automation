import type { ActionType } from "@support-automation/shared";

/**
 * Composite idempotency key for an outbound send action: WhatsApp account +
 * chat + incoming message + rule + action type (per the locked
 * architecture's duplicate-prevention design). A unique DB constraint on
 * this column is what actually enforces "never send the same reply twice",
 * not just this string construction.
 */
export function buildOutboundIdempotencyKey(params: {
  accountId: string;
  chatId: string;
  incomingMessageId: string;
  ruleId: string | null;
  actionType: ActionType;
  /**
   * Distinguishes two DIFFERENT sends that a single incoming message can legitimately produce.
   *
   * Needed because the AI fallback emits two kinds of rule-less AUTO_REPLY for one customer
   * message — the drafted answer, and the "@Rakib, please help" handover mention — and without a
   * variant both collapse to `<account>:<chat>:<message>:system:AUTO_REPLY`. They never occur
   * together in one pass, so nothing collided day to day; a re-run of a stranded message did.
   * The first pass handed over and queued a mention, the retry drafted a real answer, and the
   * unique constraint silently swallowed it as "already queued" — the customer got the tag and
   * never got the reply, with no failure recorded anywhere.
   *
   * Omitted for every ordinary send, so existing keys are byte-identical to what they were.
   */
  variant?: string;
}): string {
  return [
    params.accountId,
    params.chatId,
    params.incomingMessageId,
    params.ruleId ?? "system",
    params.actionType,
    ...(params.variant ? [params.variant] : []),
  ].join(":");
}

/** One AutomationExecution row per (message, rule) pair — prevents double-processing on redelivery. */
export function buildExecutionIdempotencyKey(params: {
  messageId: string;
  ruleId: string | null;
}): string {
  return `${params.messageId}:${params.ruleId ?? "system"}`;
}
