import { prisma } from "@support-automation/db";

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
      status: { in: ["PENDING", "PROCESSING", "SENT"] },
      createdAt: { gte: since },
      ...(params.excludeOutboundMessageId ? { id: { not: params.excludeOutboundMessageId } } : {}),
    },
    select: { id: true },
  });
  return recent !== null;
}
