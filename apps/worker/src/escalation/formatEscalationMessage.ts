import { prisma } from "@support-automation/db";
import type { SupportEscalationCase } from "@prisma/client";
import { renderNotification } from "../notifications/templates.js";

/**
 * Which template each tier uses. The five differ only in their heading, but they are five separate
 * templates rather than one with a `{{title}}` variable: a deployment that wants the admin
 * escalation to read differently from the first nudge should be able to rewrite it outright, and a
 * shared body with a swapped heading cannot express that.
 */
const TIER_TEMPLATE: Record<string, string> = {
  FIRST_NOTIFICATION: "ESCALATION_FIRST",
  SECOND_NOTIFICATION: "ESCALATION_SECOND",
  MEMBER_NOTIFICATION: "ESCALATION_MEMBER",
  ADMIN_NOTIFICATION: "ESCALATION_ADMIN",
  FOLLOW_UP: "ESCALATION_FOLLOW_UP",
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

  return renderNotification(TIER_TEMPLATE[eventType] ?? "ESCALATION_FIRST", {
    priority: caseRow.priority,
    groupName: group?.name ?? "(unknown group)",
    clientName: triggerMessage?.senderName ?? caseRow.clientPhone,
    waitingMinutes: String(waitingMinutes),
    customerMessage: truncate(triggerMessage?.body ?? "(message unavailable)", 300),
    // Empty rather than a placeholder word: renderNotificationTemplate drops a label whose only
    // content was an empty variable, so an unassigned case simply has no "Assigned to" line
    // instead of one reading "Assigned to: (nobody)".
    assignedTo: recipientName ?? "",
  });
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}
