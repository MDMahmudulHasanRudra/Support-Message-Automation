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
  ruleId: string;
  cooldownSeconds: number;
}): Promise<boolean> {
  if (params.cooldownSeconds <= 0) return false;

  const since = new Date(Date.now() - params.cooldownSeconds * 1000);
  const recent = await prisma.outboundMessage.findFirst({
    where: {
      accountId: params.accountId,
      toPhone: params.toPhone,
      ruleId: params.ruleId,
      status: { in: ["PENDING", "PROCESSING", "SENT"] },
      createdAt: { gte: since },
    },
    select: { id: true },
  });
  return recent !== null;
}
