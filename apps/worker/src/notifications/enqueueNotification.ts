import { prisma } from "../db.js";
import type { NotificationEvent, NotificationType, Prisma } from "@prisma/client";
import { getDirectRecipients, getEventDelivery } from "./eventSettings.js";

/**
 * Records a notification to be sent. The actual delivery (Teams webhook /
 * WhatsApp support group) is handled asynchronously by the notification
 * dispatcher (notifications/dispatcher.ts) so a slow/failing webhook can
 * never block message processing.
 *
 * Every caller now names the EVENT it is raising, which is what the Notification Center routes and
 * mutes on. The check lives here rather than at each of the five call sites so a new caller cannot
 * forget it, and so muting an event genuinely means nothing is written — not that a row is created
 * and then quietly skipped at delivery, which would leave the log full of things that never went.
 */
export async function enqueueNotification(params: {
  type: NotificationType;
  /** Why this is being raised — the Notification Center's unit of routing and muting. */
  event: NotificationEvent;
  destination: string;
  /** Which WhatsApp account this will send through — only meaningful for type=WHATSAPP; always resolved via resolveWhatsAppAccount(), never guessed. */
  accountId?: string | null;
  relatedMessageId?: string | null;
  relatedRuleId?: string | null;
  relatedPatternCandidateId?: string | null;
  payload: Record<string, unknown>;
  /**
   * Leave out the opted-in members' personal copies. For a caller that announces one event in
   * several places (Mood Detection's team routing and its internal escalation group), so nobody
   * gets the same direct message once per destination.
   */
  skipDirectRecipients?: boolean;
}): Promise<{ id: string; suppressed?: true }> {
  const delivery = await getEventDelivery(params.event);
  if (!delivery.enabled || !delivery.allowsChannel(params.type)) {
    // Nothing is written. The caller gets an id-shaped result so its own bookkeeping (an
    // AiFallbackDecision's notificationId, say) does not need a second code path, but no delivery
    // row exists and the dispatcher will never see it.
    return { id: "", suppressed: true };
  }

  // Direct copies to the people who asked to be told about this event personally. Additive: the
  // shared group is still notified below, and a DM never replaces it — the group is the record,
  // the DM is the tap on the shoulder.
  //
  // WhatsApp only, and only for the WhatsApp copy, so a Teams webhook does not also fan out to
  // everyone's phone. Failures are swallowed per recipient: one person with a stale number must
  // not stop the alert reaching the group or the others.
  if (params.type === "WHATSAPP" && params.accountId && !params.skipDirectRecipients) {
    for (const recipient of await getDirectRecipients(params.event)) {
      // Skip if this alert is already going to that exact chat, so somebody who has opted in AND
      // is in the destination group does not get it twice.
      if (recipient.chatId === params.destination) continue;
      try {
        await prisma.notification.create({
          data: {
            type: "WHATSAPP",
            event: params.event,
            destination: recipient.chatId,
            accountId: params.accountId,
            relatedMessageId: params.relatedMessageId ?? null,
            relatedRuleId: params.relatedRuleId ?? null,
            relatedPatternCandidateId: params.relatedPatternCandidateId ?? null,
            payload: params.payload as Prisma.InputJsonValue,
          },
        });
      } catch {
        // Deliberately quiet: the group copy below is what matters.
      }
    }
  }

  const created = await prisma.notification.create({
    data: {
      type: params.type,
      destination: params.destination,
      accountId: params.accountId ?? null,
      relatedMessageId: params.relatedMessageId ?? null,
      relatedRuleId: params.relatedRuleId ?? null,
      relatedPatternCandidateId: params.relatedPatternCandidateId ?? null,
      event: params.event,
      payload: params.payload as Prisma.InputJsonValue,
    },
  });
  return { id: created.id };
}
