import { prisma } from "@support-automation/db";
import type { ActionType, AutomationSettings } from "@prisma/client";
import { buildOutboundIdempotencyKey } from "./idempotency.js";

function randomDelayMs(minMs: number, maxMs: number): number {
  if (maxMs <= minMs) return minMs;
  return minMs + Math.floor(Math.random() * (maxMs - minMs));
}

/**
 * Queues an outbound send. Never sends directly — every automatic message
 * goes through the DB-backed queue (queue/outboundQueueProcessor.ts) so
 * rate limiting, cooldown re-checks, and retry policy all apply uniformly,
 * and a worker crash between "decided to reply" and "sent" can never lose
 * or duplicate the send.
 *
 * Idempotent: if this exact (account, chat, message, rule, actionType)
 * combination was already queued — e.g. a duplicate provider event slipped
 * through, or a retry re-ran this step — the unique constraint on
 * idempotencyKey makes this a no-op instead of a duplicate row.
 */
export async function enqueueOutboundMessage(params: {
  accountId: string;
  chatId: string;
  toPhone: string;
  body: string;
  incomingMessageId: string;
  ruleId: string | null;
  actionType: ActionType;
  settings: Pick<AutomationSettings, "defaultReplyDelayMinMs" | "defaultReplyDelayMaxMs">;
  ruleDelayMinMs?: number | null;
  ruleDelayMaxMs?: number | null;
}): Promise<{ queued: boolean; outboundMessageId?: string }> {
  const idempotencyKey = buildOutboundIdempotencyKey({
    accountId: params.accountId,
    chatId: params.chatId,
    incomingMessageId: params.incomingMessageId,
    ruleId: params.ruleId,
    actionType: params.actionType,
  });

  const delayMs = randomDelayMs(
    params.ruleDelayMinMs ?? params.settings.defaultReplyDelayMinMs,
    params.ruleDelayMaxMs ?? params.settings.defaultReplyDelayMaxMs,
  );

  try {
    const created = await prisma.outboundMessage.create({
      data: {
        accountId: params.accountId,
        chatId: params.chatId,
        toPhone: params.toPhone,
        body: params.body,
        relatedMessageId: params.incomingMessageId,
        ruleId: params.ruleId,
        actionType: params.actionType,
        idempotencyKey,
        delayMs,
        scheduledAt: new Date(Date.now() + delayMs),
      },
    });
    return { queued: true, outboundMessageId: created.id };
  } catch (err: any) {
    if (err?.code === "P2002") {
      return { queued: false }; // already queued — idempotent no-op
    }
    throw err;
  }
}
