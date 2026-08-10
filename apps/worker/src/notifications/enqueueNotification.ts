import { prisma } from "@support-automation/db";
import type { NotificationType, Prisma } from "@prisma/client";

/**
 * Records a notification to be sent. The actual delivery (Teams webhook /
 * WhatsApp support group) is handled asynchronously by the notification
 * dispatcher (notifications/dispatcher.ts) so a slow/failing webhook can
 * never block message processing.
 */
export async function enqueueNotification(params: {
  type: NotificationType;
  destination: string;
  relatedMessageId?: string | null;
  relatedRuleId?: string | null;
  payload: Record<string, unknown>;
}): Promise<void> {
  await prisma.notification.create({
    data: {
      type: params.type,
      destination: params.destination,
      relatedMessageId: params.relatedMessageId ?? null,
      relatedRuleId: params.relatedRuleId ?? null,
      payload: params.payload as Prisma.InputJsonValue,
    },
  });
}
