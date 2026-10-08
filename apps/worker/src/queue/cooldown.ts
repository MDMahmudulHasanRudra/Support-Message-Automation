import { prisma } from "../db.js";
import { MOOD_CUSTOMER_MESSAGE_VARIANT, UNABLE_TO_UNDERSTAND_VARIANT } from "@support-automation/shared";

/**
 * True if this client already has a reply for this rule in flight or sent
 * within the cooldown window — covers the "same client sends the same
 * trigger multiple times within the cooldown" case from the safety spec.
 * In-flight (PENDING/PROCESSING) counts too, so a burst of duplicate events
 * can't queue multiple replies before the first one is even sent.
 */
export async function isCooldownActive(params: {
  accountId: string;
  toPhone: string;
  /** Null scopes this to the Hybrid AI Automation fallback layer's own cooldown bucket (an
   * AI-authored reply has no AutomationRule row at all) — see safety.ts's doc comment. */
  ruleId: string | null;
  cooldownSeconds: number;
  /**
   * PHASE 6.1 — real bug, reproduced live: the send-time re-check in
   * outboundQueueProcessor.ts runs AFTER claimNextOutboundMessage() has
   * already flipped the message's own row to PROCESSING, so without
   * excluding it here this query always finds the row itself and reports
   * "cooldown active" on effectively every send — confirmed via two real
   * outbound replies both cancelled with "Cooldown became active" despite
   * being the first-ever message to each recipient. The queue-time check in
   * safety.ts has no id yet at that point, so this stays optional.
   */
  excludeOutboundMessageId?: string;
}): Promise<boolean> {
  if (params.cooldownSeconds <= 0) return false;

  const since = new Date(Date.now() - params.cooldownSeconds * 1000);
  const recent = await prisma.outboundMessage.findFirst({
    where: {
      accountId: params.accountId,
      toPhone: params.toPhone,
      ruleId: params.ruleId,
      // Every cooldown-eligible send (rule-based or AI) is an AUTO_REPLY — explicit filter so a
      // null-ruleId FORWARD/GROUP_BROADCAST row (a different action entirely) can never be
      // mistaken for AI-cooldown activity against the same (accountId, toPhone) pair.
      actionType: "AUTO_REPLY",
      // A cooldown asks "have we already ANSWERED this client recently". The AI handover mention
      // ("@Rakib, please help") is enqueued as a rule-less AUTO_REPLY too, so it landed in this
      // bucket and stood in for an answer it is the opposite of — a request for a person, raised
      // precisely BECAUSE nothing was answered.
      //
      // That was self-sustaining. The mention itself never passes checkAutoReplySafety, so every
      // further customer message inside the window was blocked by the previous mention, and each
      // block posted another mention that re-armed the window from its own createdAt. A customer
      // writing every few minutes could never be answered again, and watched the team be tagged
      // over and over in their own group.
      //
      // Mentions are the only rows this path ever gives a non-empty `mentions` array, so this is
      // an exact identification of them and touches no ordinary reply.
      mentions: { isEmpty: true },
      // The "we could not understand, the team will follow up" holding reply is the same shape of
      // row and the same kind of thing: sent BECAUSE nothing was answered. Counting it would block
      // the customer's next, clearer message from being answered, and cancel the handover mention
      // queued right after it at send time. `idempotencyKey` is required, so NOT is NULL-safe here.
      //
      // Mood Detection's message to an upset customer is the same again: sent because a person is
      // needed, never an answer.
      NOT: [
        { idempotencyKey: { endsWith: `:${UNABLE_TO_UNDERSTAND_VARIANT}` } },
        { idempotencyKey: { endsWith: `:${MOOD_CUSTOMER_MESSAGE_VARIANT}` } },
      ],
      status: { in: ["PENDING", "PROCESSING", "SENT"] },
      createdAt: { gte: since },
      ...(params.excludeOutboundMessageId ? { id: { not: params.excludeOutboundMessageId } } : {}),
    },
    select: { id: true },
  });
  return recent !== null;
}
