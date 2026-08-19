import { prisma } from "@support-automation/db";

/**
 * Hybrid AI Automation's human-takeover mechanism (Slice 3). Deliberately per-GROUP, not
 * per-individual-customer-within-the-group, and a simple cooldown-expiry timestamp rather than a
 * state machine — see WhatsAppGroup.aiSuppressedUntil's schema doc comment for the full rationale.
 * Called from processIncomingMessage.ts's existing isFromTeamMember branch, alongside (not
 * replacing) the pre-existing markHumanReplied() escalation call — a separate concern (SLA-timer
 * tracking vs. AI eligibility).
 */
export async function recordHumanTakeover(groupId: string): Promise<void> {
  const settings = await prisma.aiSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
  const suppressedUntil = new Date(Date.now() + settings.humanTakeoverCooldownMinutes * 60_000);
  await prisma.whatsAppGroup.update({ where: { id: groupId }, data: { aiSuppressedUntil: suppressedUntil } });
}
