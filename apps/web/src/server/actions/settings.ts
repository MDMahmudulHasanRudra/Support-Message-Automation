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

  // The kill switch must "immediately stop queued outbound group sending" (Group Message Sender safety
  // requirement) — the queue processor's own per-row check (outboundQueueProcessor.ts) is a safety net for
  // rows it hasn't reached yet, but this bulk sweep means every already-queued group message stops right now,
  // not whenever the 2-second queue tick happens to reach each row.
  if (!enabled) {
    const affectedJobIds = await prisma.outboundMessage.findMany({
      where: { actionType: "GROUP_BROADCAST", status: "PENDING", broadcastJobId: { not: null } },
      select: { broadcastJobId: true },
      distinct: ["broadcastJobId"],
    });
    await prisma.outboundMessage.updateMany({
      where: { actionType: "GROUP_BROADCAST", status: "PENDING" },
      data: { status: "CANCELLED", failureReason: "Stopped by kill switch." },
    });
    const jobIds = affectedJobIds.map((row) => row.broadcastJobId).filter((id): id is string => Boolean(id));
    if (jobIds.length > 0) {
      await prisma.groupBroadcastJob.updateMany({
        where: { id: { in: jobIds }, status: { notIn: ["CANCELLED", "STOPPED_KILL_SWITCH"] } },
        data: { status: "STOPPED_KILL_SWITCH", cancelledAt: new Date() },
      });
    }
    revalidatePath("/group-message-sender");
  }

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
      whatsappNotificationGroupIds: formData.getAll("whatsappNotificationGroupIds").map(String),
    },
  });

  revalidatePath("/settings");
  return { success: true };
}
