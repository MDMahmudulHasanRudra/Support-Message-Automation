import { prisma } from "../db.js";
import type { NotificationEvent, NotificationType } from "@prisma/client";
import { buildWhatsAppContactId, hasReachablePhoneNumber, normalizePhoneNumber } from "@support-automation/shared";

/**
 * The Notification Center's read side, used by every place that raises a notification.
 *
 * Before this, an event was delivered wherever the two global destination settings pointed, for
 * every kind of alert equally. A team drowning in unknown-pattern alerts had one option: turn off
 * the notification group, which also silenced escalations. This makes muting one reason possible
 * without losing the others.
 *
 * Fails OPEN throughout. An unreadable settings row, a missing table on a not-yet-migrated
 * deployment, a database hiccup — all of them let the notification through rather than swallowing
 * it. A notification that should have been suppressed is noise; one that was silently dropped is
 * an escalation nobody saw.
 */

export interface EventDelivery {
  /** False means raise nothing at all for this event. */
  enabled: boolean;
  /** Whether this channel is wanted for this event. */
  allowsChannel: (type: NotificationType) => boolean;
  /**
   * WhatsApp groups configured for this event specifically, or null to use the global list.
   * Null rather than an empty array on purpose: "not configured" and "configured to nowhere" are
   * different intentions, and only the first should fall back.
   */
  whatsappGroupIds: string[] | null;
}

const ALLOW_EVERYTHING: EventDelivery = {
  enabled: true,
  allowsChannel: () => true,
  whatsappGroupIds: null,
};

export async function getEventDelivery(event: NotificationEvent): Promise<EventDelivery> {
  try {
    const setting = await prisma.notificationEventSetting.findFirst({ where: { event } });
    // No row means never configured, which must behave exactly as it did before the Notification
    // Center existed. Rows are created only when an admin saves something.
    if (!setting) return ALLOW_EVERYTHING;

    return {
      enabled: setting.enabled,
      allowsChannel: (type) => (type === "TEAMS" ? setting.sendToTeams : setting.sendToWhatsApp),
      whatsappGroupIds: setting.whatsappGroupIds.length > 0 ? setting.whatsappGroupIds : null,
    };
  } catch {
    return ALLOW_EVERYTHING;
  }
}

/**
 * The WhatsApp groups an event should go to: its own list if it has one, otherwise the global
 * destinations the deployment already had configured.
 */
export function resolveWhatsAppDestinations(delivery: EventDelivery, globalGroupIds: string[]): string[] {
  return delivery.whatsappGroupIds ?? globalGroupIds;
}

export interface DirectRecipient {
  teamMemberId: string;
  name: string;
  /** The 1:1 WhatsApp chat id to send to. */
  chatId: string;
}

/**
 * The team members who asked to be told about this event directly, as opposed to via a shared
 * group.
 *
 * Silently skips anyone unreachable — someone mapped from message history has a WhatsApp id where
 * their phone number should be, which identifies them in a group perfectly and cannot receive a
 * direct message. That is surfaced where it can be fixed (a "Needs phone number" badge on Team
 * Members) rather than as a delivery failure per alert, which would be noise on every escalation.
 *
 * Fails closed on error, unlike the rest of this module: a direct message is an ADDITION to the
 * group alert, never a replacement for it. If this throws, the shared group has still been told,
 * so the safe move is to send no extra copies rather than risk duplicating one.
 */
export async function getDirectRecipients(event: NotificationEvent): Promise<DirectRecipient[]> {
  try {
    const preferences = await prisma.teamMemberNotificationPreference.findMany({
      where: { event, teamMember: { status: "ACTIVE" } },
      select: { teamMember: { select: { id: true, name: true, phoneNumber: true, whatsappId: true } } },
    });

    const recipients: DirectRecipient[] = [];
    for (const { teamMember } of preferences) {
      if (!hasReachablePhoneNumber(teamMember)) continue;
      const digits = normalizePhoneNumber(teamMember.phoneNumber);
      if (!digits) continue;
      recipients.push({
        teamMemberId: teamMember.id,
        name: teamMember.name,
        chatId: buildWhatsAppContactId(digits),
      });
    }
    return recipients;
  } catch {
    return [];
  }
}
