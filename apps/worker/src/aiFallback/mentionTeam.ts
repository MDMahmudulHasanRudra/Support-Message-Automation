import { prisma } from "../db.js";
import { buildWhatsAppContactId, hasReachablePhoneNumber, normalizePhoneNumber } from "@support-automation/shared";
import { enqueueOutboundMessage } from "../pipeline/enqueueOutbound.js";
import { logSystemEvent } from "../logging/logSystemEvent.js";
import { renderNotification } from "../notifications/templates.js";

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

/**
 * How long a request for help stands before it is worth making again in the same conversation.
 *
 * Every handover reason posts a mention, and a customer who keeps writing produces a handover per
 * message — an unanswered question, a throttled reply, a screenshot this system cannot read are
 * all handovers. Without this, four messages in five minutes tagged the same person four times in
 * front of the customer. That is not escalation; it is the unprompted repeat sending this product
 * refuses to do, and it makes the tag easy to start ignoring.
 *
 * Fifteen minutes, and deliberately not configurable: it is not a throttle an operator should be
 * tuning, and the separate alert to the notifications group is raised every single time regardless
 * — so nothing is lost, only the repetition the customer can see. When a colleague does arrive,
 * `recordHumanTakeover` suppresses the AI for this group outright and no further mention is
 * reached at all.
 */
const MENTION_REPEAT_WINDOW_MS = 15 * 60_000;

/** Who to tag, in preference order, plus the group's own name for the message template. */
async function resolveMentionTargets(
  groupId: string,
): Promise<{ targets: Array<{ name: string; chatId: string }>; groupName: string }> {
  const group = await prisma.whatsAppGroup.findUnique({
    where: { id: groupId },
    select: {
      name: true,
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
  return { targets, groupName: group?.name ?? "" };
}

/**
 * Whether somebody was already tagged in this conversation inside the repeat window.
 *
 * Counts queued rows as well as sent ones: the whole point is a burst, and a burst arrives faster
 * than the 2-second queue drains. A non-empty `mentions` array is what identifies these rows — no
 * ordinary reply on this path ever carries one.
 *
 * Fails OPEN. If the lookup throws, the mention is still posted: a duplicate tag is noise, while
 * silently swallowing a request for help leaves a customer waiting with nobody told, and those two
 * are not the same size of mistake.
 */
async function mentionedRecently(accountId: string, chatId: string): Promise<boolean> {
  try {
    const recent = await prisma.outboundMessage.findFirst({
      where: {
        accountId,
        chatId,
        mentions: { isEmpty: false },
        status: { in: ["PENDING", "PROCESSING", "SENT"] },
        createdAt: { gte: new Date(Date.now() - MENTION_REPEAT_WINDOW_MS) },
      },
      select: { id: true },
    });
    return recent !== null;
  } catch (err) {
    console.error("[aiFallback] could not check for a recent handover mention; posting it", err);
    return false;
  }
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
    if (await mentionedRecently(params.accountId, params.chatId)) return false;

    const { targets, groupName } = await resolveMentionTargets(params.groupId);
    if (targets.length === 0) {
      await logSystemEvent("INFO", "ai-fallback", "Handover mention skipped — nobody taggable for this group", {
        groupId: params.groupId,
      });
      return false;
    }

    // WhatsApp renders a mention as the @-prefixed number in the body; the client displays the
    // saved name over it. The names are included in plain text too so the message still reads
    // sensibly for anyone whose phone shows the raw number instead.
    //
    // The wording is editable (Notification Templates) because the customer reads it — this is the
    // one alert in the system that is the company speaking rather than an internal note. {{mentions}}
    // is required at save time: without it the tags vanish and the message announces that help was
    // summoned while reaching nobody.
    const tags = targets.map((target) => `@${target.chatId.split("@")[0]}`).join(" ");
    const names = targets.map((target) => target.name).join(", ");
    const body = await renderNotification("AI_HANDOVER_MENTION", {
      mentions: tags,
      names,
      groupName,
    });

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
      // Its own bucket, so a retry that finally produces a real answer is not mistaken for this
      // mention and discarded. Still idempotent: a second mention for the SAME customer message
      // collapses onto this same key, as it always did.
      idempotencyVariant: "handover-mention",
    });
    return queued;
  } catch (err) {
    await logSystemEvent("WARN", "ai-fallback", "Handover mention failed", { error: (err as Error).message });
    return false;
  }
}
