import type { NotificationEvent } from "@prisma/client";

/**
 * The notification event catalogue, in the order the Notification Center lists them: most
 * consequential to mute at the top, safest at the bottom.
 *
 * Lives here rather than beside the server action because a `"use server"` module may only export
 * async functions — exporting this array from there builds fine locally and fails at
 * `next build` with "A 'use server' file can only export async functions, found object".
 */
export const NOTIFICATION_EVENTS = [
  "SUPPORT_ESCALATION",
  "AI_HUMAN_FALLBACK",
  "RULE_NOTIFY_WHATSAPP",
  "RULE_NOTIFY_TEAMS",
  "UNKNOWN_PATTERN",
] as const satisfies readonly NotificationEvent[];

export function isNotificationEvent(value: string): value is NotificationEvent {
  return (NOTIFICATION_EVENTS as readonly string[]).includes(value);
}
