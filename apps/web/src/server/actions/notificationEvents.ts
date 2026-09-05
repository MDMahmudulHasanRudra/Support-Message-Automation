"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@support-automation/db";
import type { NotificationEvent } from "@prisma/client";
import { requireSession } from "@/server/auth";
import { isNotificationEvent } from "@/lib/notificationEvents";

/**
 * The Notification Center's write side: which alerts are raised, on which channels, to where.
 *
 * Rows are created lazily. A deployment that never opens this page has no rows, and no rows means
 * "behave exactly as before" — every event enabled, on both channels, to the global destinations.
 * That is deliberate: the module has to be additive, not a new thing everyone must configure
 * before their alerts start working again.
 */

export async function updateNotificationEvent(formData: FormData): Promise<void> {
  await requireSession();

  const event = String(formData.get("event") ?? "");
  if (!isNotificationEvent(event)) throw new Error("Unknown notification event.");

  const enabled = formData.get("enabled") === "on";
  const sendToTeams = formData.get("sendToTeams") === "on";
  const sendToWhatsApp = formData.get("sendToWhatsApp") === "on";
  const whatsappGroupIds = formData.getAll("whatsappGroupIds").map(String).filter(Boolean);

  await prisma.notificationEventSetting.upsert({
    where: { event },
    update: { enabled, sendToTeams, sendToWhatsApp, whatsappGroupIds },
    create: { event, enabled, sendToTeams, sendToWhatsApp, whatsappGroupIds },
  });

  revalidatePath("/notifications/events");
  revalidatePath("/notifications");
}

/** One switch, for the mute/unmute button on each row — the action people reach for most. */
export async function setNotificationEventEnabled(event: string, enabled: boolean): Promise<void> {
  await requireSession();
  if (!isNotificationEvent(event)) throw new Error("Unknown notification event.");

  await prisma.notificationEventSetting.upsert({
    where: { event },
    update: { enabled },
    create: { event, enabled },
  });

  revalidatePath("/notifications/events");
  revalidatePath("/notifications");
}

/**
 * Which events one team member wants as a direct message.
 *
 * Stored as presence rather than a row per event with a boolean: an opt-in that does not exist is
 * simply off, so a new event type added later does not silently start messaging everybody who
 * happened to have a row.
 */
export async function updateMemberNotificationPreferences(
  teamMemberId: string,
  formData: FormData,
): Promise<void> {
  await requireSession();

  const chosen = formData
    .getAll("events")
    .map(String)
    .filter(isNotificationEvent);

  await prisma.$transaction([
    prisma.teamMemberNotificationPreference.deleteMany({ where: { teamMemberId } }),
    prisma.teamMemberNotificationPreference.createMany({
      data: chosen.map((event) => ({ teamMemberId, event })),
      skipDuplicates: true,
    }),
  ]);

  revalidatePath(`/team-members/${teamMemberId}/edit`);
  revalidatePath("/notifications/events");
}
