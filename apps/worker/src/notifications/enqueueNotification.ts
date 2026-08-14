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
  /** Which WhatsApp account this will send through — only meaningful for type=WHATSAPP; always resolved via resolveWhatsAppAccount(), never guessed. */
  accountId?: string | null;
  relatedMessageId?: string | null;
  relatedRuleId?: string | null;
  relatedPatternCandidateId?: string | null;
  payload: Record<string, unknown>;
}): Promise<void> {
  await prisma.notification.create({
    data: {
      type: params.type,
      destination: params.destination,
      accountId: params.accountId ?? null,
      relatedMessageId: params.relatedMessageId ?? null,
      relatedRuleId: params.relatedRuleId ?? null,
      relatedPatternCandidateId: params.relatedPatternCandidateId ?? null,
      payload: params.payload as Prisma.InputJsonValue,
    },
  });
}
