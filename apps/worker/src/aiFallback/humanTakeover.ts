import { prisma } from "@support-automation/db";

export interface HumanTakeoverGroup {
  id: string;
  isMonitored: boolean;
  aiAutomationEnabled: boolean;
  aiAutomationExcluded: boolean;
}

/**
 * Hybrid AI Automation's human-takeover mechanism (Slice 3). Deliberately per-GROUP, not
 * per-individual-customer-within-the-group, and a simple cooldown-expiry timestamp rather than a
 * state machine — see WhatsAppGroup.aiSuppressedUntil's schema doc comment for the full rationale.
 * Called from processIncomingMessage.ts's existing isFromTeamMember branch, alongside (not
 * replacing) the pre-existing markHumanReplied() escalation call — a separate concern (SLA-timer
 * tracking vs. AI eligibility).
 *
 * Whether a group is AI-eligible is decided here rather than by the caller, because the answer
 * now depends on AiSettings.aiAutomationScope and this function already reads that row. The
 * caller used to test `group.aiAutomationEnabled` itself, which was correct while per-group
 * opt-in was the only mode — but under ALL_MONITORED_GROUPS that flag is usually false, so a
 * human replying would not have paused the AI at all.
 */
export async function recordHumanTakeover(group: HumanTakeoverGroup): Promise<void> {
  const settings = await prisma.aiSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });

  // Skip the write for a group AI could never answer in anyway — suppressing a group that has
  // no AI to suppress is a pointless row update on every team-member message.
  const aiCouldAnswerHere =
    !group.aiAutomationExcluded &&
    group.isMonitored &&
    (settings.aiAutomationScope === "ALL_MONITORED_GROUPS" || group.aiAutomationEnabled);
  if (!aiCouldAnswerHere) return;

  const suppressedUntil = new Date(Date.now() + settings.humanTakeoverCooldownMinutes * 60_000);
  await prisma.whatsAppGroup.update({ where: { id: group.id }, data: { aiSuppressedUntil: suppressedUntil } });
}
