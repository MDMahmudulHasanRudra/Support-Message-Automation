"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";

export async function retryNotification(id: string): Promise<void> {
  await requireSession();
  await prisma.notification.update({
    where: { id },
    data: { status: "PENDING", failureReason: null },
  });
  revalidatePath("/notifications");
}

export interface TestNotificationState {
  error?: string;
  success?: boolean;
}

export async function sendTestNotification(_prevState: TestNotificationState, formData: FormData): Promise<TestNotificationState> {
  await requireSession();
  const settings = await prisma.automationSettings.findUnique({ where: { id: "global" } });
  if (!settings?.teamsWebhookUrl) {
    return { error: "Configure a Teams webhook URL in Settings first." };
  }

  await prisma.notification.create({
    data: {
      type: "TEAMS",
      destination: settings.teamsWebhookUrl,
      payload: {
        message: String(formData.get("message") ?? "This is a test notification from the dashboard."),
        matchedRuleName: "(manual test)",
      },
    },
  });
  revalidatePath("/notifications");
  return { success: true };
}
