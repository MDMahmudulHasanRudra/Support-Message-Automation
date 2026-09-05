import { prisma } from "@support-automation/db";
import type { NotificationEvent, NotificationType } from "@prisma/client";

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
    const setting = await prisma.notificationEventSetting.findUnique({ where: { event } });
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
