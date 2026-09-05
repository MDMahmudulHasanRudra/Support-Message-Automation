import { prisma } from "@support-automation/db";
import { buildWhatsAppContactId, hasReachablePhoneNumber, normalizePhoneNumber } from "@support-automation/shared";
import { enqueueOutboundMessage } from "../pipeline/enqueueOutbound.js";
import { logSystemEvent } from "../logging/logSystemEvent.js";

/**
 * Asks for help inside the customer's own group, by name.
 *
 * The existing handover alert goes to a separate notifications group. That tells the team, but it
 * does not tell them *where*, and the customer sees nothing happen at all. This posts in the
 * conversation itself and tags a person, so the request lands where the work is and the customer
 * can see somebody has been called.
 *
 * Off by default (`AiSettings.mentionTeamOnHandover`): it puts an extra message in front of a
 * customer, which is a decision about tone, not just plumbing.
 *
 * Goes through the outbound queue like every other send — rate limits, membership verification and
 * idempotency all apply. It is not a second send path.
 */

/** Who to tag, in preference order. */
async function resolveMentionTargets(groupId: string): Promise<Array<{ name: string; chatId: string }>> {
  const group = await prisma.whatsAppGroup.findUnique({
    where: { id: groupId },
    select: {
      assignedTeamMember: { select: { id: true, name: true, phoneNumber: true, whatsappId: true, status: true } },
    },
  });

  // The person who owns this group is the right one to ask — tagging everybody turns a request for
  // help into a broadcast nobody feels responsible for.
  const assigned = group?.assignedTeamMember;
  const candidates =
    assigned && assigned.status === "ACTIVE"
      ? [assigned]
      : await prisma.internalTeamMember.findMany({
          where: { status: "ACTIVE", notificationPreferences: { some: { event: "AI_HUMAN_FALLBACK" } } },
          select: { id: true, name: true, phoneNumber: true, whatsappId: true, status: true },
          // A handful at most: a message tagging fifteen people is noise, not escalation.
          take: 3,
        });

  const targets: Array<{ name: string; chatId: string }> = [];
  for (const member of candidates) {
    // A mention addresses a real contact. Someone mapped from message history has a WhatsApp id
    // where their number should be, and tagging that resolves to nobody — see
    // hasReachablePhoneNumber for why the two are not interchangeable.
    if (!hasReachablePhoneNumber(member)) continue;
    const digits = normalizePhoneNumber(member.phoneNumber);
    if (!digits) continue;
    targets.push({ name: member.name, chatId: buildWhatsAppContactId(digits) });
  }
  return targets;
}

export interface MentionHandoverParams {
  accountId: string;
  groupId: string;
  chatId: string;
  toPhone: string;
  incomingMessageId: string;
  settings: { defaultReplyDelayMinMs: number; defaultReplyDelayMaxMs: number };
  testMode: boolean;
}

/**
 * Returns true when a mention was queued. Never throws — the caller has already handed the
 * conversation to a human by other means, and failing to also tag someone must not undo that.
 */
export async function mentionTeamForHandover(params: MentionHandoverParams): Promise<boolean> {
  try {
    const targets = await resolveMentionTargets(params.groupId);
    if (targets.length === 0) {
      await logSystemEvent("INFO", "ai-fallback", "Handover mention skipped — nobody taggable for this group", {
        groupId: params.groupId,
      });
      return false;
    }

    // WhatsApp renders a mention as the @-prefixed number in the body; the client displays the
    // saved name over it. The names are included in plain text too so the message still reads
    // sensibly for anyone whose phone shows the raw number instead.
    const tags = targets.map((target) => `@${target.chatId.split("@")[0]}`).join(" ");
    const names = targets.map((target) => target.name).join(", ");
    const body = `${tags}\n\nA customer here needs a person — ${names}, could you take a look?`;

    const { queued } = await enqueueOutboundMessage({
      accountId: params.accountId,
      chatId: params.chatId,
      toPhone: params.toPhone,
      body,
      incomingMessageId: params.incomingMessageId,
      ruleId: null,
      actionType: "AUTO_REPLY",
      settings: params.settings,
      testMode: params.testMode,
      mentions: targets.map((target) => target.chatId),
    });
    return queued;
  } catch (err) {
    await logSystemEvent("WARN", "ai-fallback", "Handover mention failed", { error: (err as Error).message });
    return false;
  }
}
