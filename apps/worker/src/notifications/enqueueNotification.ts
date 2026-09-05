import { prisma } from "@support-automation/db";
import type { NotificationEvent, NotificationType, Prisma } from "@prisma/client";
import { getEventDelivery } from "./eventSettings.js";

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
}): Promise<{ id: string; suppressed?: true }> {
  const delivery = await getEventDelivery(params.event);
  if (!delivery.enabled || !delivery.allowsChannel(params.type)) {
    // Nothing is written. The caller gets an id-shaped result so its own bookkeeping (an
    // AiFallbackDecision's notificationId, say) does not need a second code path, but no delivery
    // row exists and the dispatcher will never see it.
    return { id: "", suppressed: true };
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
