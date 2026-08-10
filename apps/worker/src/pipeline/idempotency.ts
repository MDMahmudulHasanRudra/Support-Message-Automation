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
}): string {
  return [
    params.accountId,
    params.chatId,
    params.incomingMessageId,
    params.ruleId ?? "system",
    params.actionType,
  ].join(":");
}

/** One AutomationExecution row per (message, rule) pair — prevents double-processing on redelivery. */
export function buildExecutionIdempotencyKey(params: {
  messageId: string;
  ruleId: string | null;
}): string {
  return `${params.messageId}:${params.ruleId ?? "system"}`;
}
