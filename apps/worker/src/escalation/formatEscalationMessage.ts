import { prisma } from "@support-automation/db";
import type { SupportEscalationCase } from "@prisma/client";

const EVENT_TITLES: Record<string, string> = {
  FIRST_NOTIFICATION: "🔔 PRIORITY SUPPORT — New Message",
  SECOND_NOTIFICATION: "🚨 HIGH PRIORITY SUPPORT — Still Waiting",
  MEMBER_NOTIFICATION: "🚨 Personal Reminder — Priority Client Waiting",
  ADMIN_NOTIFICATION: "🆘 ESCALATED TO ADMIN — No Human Response Yet",
  FOLLOW_UP: "🆘 ESCALATION FOLLOW-UP — Still Unresolved",
};

/**
 * Builds the WhatsApp message body for one escalation tier. Queries the group name and the
 * trigger message's text fresh each time (escalation notifications are infrequent — minutes
 * apart at minimum — so this isn't worth denormalizing onto the case row).
 */
export async function formatEscalationAlert(params: {
  caseRow: SupportEscalationCase;
  eventType: string;
  recipientName?: string;
}): Promise<string> {
  const { caseRow, eventType, recipientName } = params;
  const [group, triggerMessage] = await Promise.all([
    prisma.whatsAppGroup.findUnique({ where: { id: caseRow.groupId }, select: { name: true } }),
    prisma.message.findUnique({ where: { id: caseRow.triggerMessageId }, select: { body: true, senderName: true } }),
  ]);

  const waitingMinutes = Math.round((Date.now() - caseRow.lastCustomerMessageAt.getTime()) / 60_000);
  const lines = [
    EVENT_TITLES[eventType] ?? eventType,
    "",
    `Priority: ${caseRow.priority}`,
    `Group: ${group?.name ?? "(unknown group)"}`,
    `Client: ${triggerMessage?.senderName ?? caseRow.clientPhone}`,
    `Waiting: ${waitingMinutes} minute(s) since last customer message`,
    `Message: ${truncate(triggerMessage?.body ?? "(message unavailable)", 300)}`,
  ];
  if (recipientName) lines.push(`Assigned to: ${recipientName}`);
  lines.push("", "Please review the conversation and respond.");
  return lines.join("\n");
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}
