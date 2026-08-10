"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";

async function getOrCreateSettings() {
  return prisma.automationSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
}

export async function setAutomationEnabled(enabled: boolean): Promise<void> {
  await requireSession();
  await getOrCreateSettings();
  await prisma.automationSettings.update({ where: { id: "global" }, data: { automationEnabled: enabled } });
  revalidatePath("/automation-control");
}

export async function setAutomationMode(mode: "MANUAL_ONLY" | "SAFE_AUTO_REPLY" | "FULL_RULE_AUTOMATION"): Promise<void> {
  await requireSession();
  await getOrCreateSettings();
  await prisma.automationSettings.update({ where: { id: "global" }, data: { mode } });
  revalidatePath("/automation-control");
}

export interface SettingsFormState {
  error?: string;
  success?: boolean;
}

export async function updateSafetySettings(_prevState: SettingsFormState, formData: FormData): Promise<SettingsFormState> {
  await requireSession();
  await getOrCreateSettings();

  const num = (key: string) => Number(formData.get(key) ?? 0);

  await prisma.automationSettings.update({
    where: { id: "global" },
    data: {
      maxRepliesPerClientPerHour: num("maxRepliesPerClientPerHour"),
      maxRepliesPerClientPerDay: num("maxRepliesPerClientPerDay"),
      globalMaxPerMinute: num("globalMaxPerMinute"),
      globalMaxPerHour: num("globalMaxPerHour"),
      globalMaxPerDay: num("globalMaxPerDay"),
      rateLimitingEnabled: formData.get("rateLimitingEnabled") === "on",
      defaultReplyDelayMinMs: num("defaultReplyDelayMinMs"),
      defaultReplyDelayMaxMs: num("defaultReplyDelayMaxMs"),
      retryMaxAttempts: num("retryMaxAttempts"),
      teamsWebhookUrl: String(formData.get("teamsWebhookUrl") ?? "").trim() || null,
      whatsappNotificationGroupId: String(formData.get("whatsappNotificationGroupId") ?? "").trim() || null,
    },
  });

  revalidatePath("/settings");
  return { success: true };
}
