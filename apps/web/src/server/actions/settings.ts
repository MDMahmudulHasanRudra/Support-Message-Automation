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

/** "30, 300, 900" -> [30000, 300000, 900000]. Falls back to the stored schedule. */
function parseRetryIntervals(raw: FormDataEntryValue | null, current: unknown): number[] {
  const fallback = Array.isArray(current) ? (current as number[]) : [30_000, 300_000, 900_000];
  const parsed = String(raw ?? "")
    .split(/[,\s]+/)
    .map((part) => Number(part.trim()))
    .filter((seconds) => Number.isFinite(seconds) && seconds > 0)
    // One second floor, one hour ceiling per step: a zero-second backoff is a retry storm, and
    // anything past an hour is indistinguishable from giving up.
    .map((seconds) => Math.min(3_600, Math.max(1, Math.round(seconds))) * 1000);
  return parsed.length > 0 ? parsed.slice(0, 10) : fallback;
}

export async function updateSafetySettings(_prevState: SettingsFormState, formData: FormData): Promise<SettingsFormState> {
  await requireSession();
  const current = await getOrCreateSettings();

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
      // Entered as seconds, stored as milliseconds — same reasoning as the broadcast delays: a
      // backoff list typed in thousandths invites a digit slip nobody notices until retries are
      // hammering a rate-limited number. An empty or unparseable list keeps the current schedule
      // rather than silently becoming "retry immediately".
      retryIntervalsMs: parseRetryIntervals(formData.get("retryIntervalsSeconds"), current.retryIntervalsMs),
      teamsWebhookUrl: String(formData.get("teamsWebhookUrl") ?? "").trim() || null,
      whatsappNotificationGroupIds: formData.getAll("whatsappNotificationGroupIds").map(String),
    },
  });

  revalidatePath("/settings");
  return { success: true };
}
