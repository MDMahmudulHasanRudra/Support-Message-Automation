"use server";

import { projectPath } from "@/server/projectPaths";
import { prisma } from "@/server/db";
import { revalidatePath } from "next/cache";

import { checkPermission, requireAccess } from "@/server/authorize";

async function getOrCreateSettings() {
  return prisma.automationSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
}

export async function setAutomationEnabled(enabled: boolean): Promise<void> {
  await requireAccess("settings.edit");
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
    revalidatePath(await projectPath("/group-message-sender"));
  }

  revalidatePath(await projectPath("/automation-control"));
}

export async function setAutomationMode(mode: "MANUAL_ONLY" | "SAFE_AUTO_REPLY" | "FULL_RULE_AUTOMATION"): Promise<void> {
  await requireAccess("settings.edit");
  await getOrCreateSettings();
  await prisma.automationSettings.update({ where: { id: "global" }, data: { mode } });
  revalidatePath(await projectPath("/automation-control"));
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
  const granted = await checkPermission("settings.edit");
  if ("denied" in granted) return { error: granted.denied };
  const current = await getOrCreateSettings();

  // An empty or malformed box keeps the current value rather than writing NaN, which Prisma
  // rejects with a raw error the operator cannot act on. Zero is allowed here because it is
  // meaningful for the fields this serves: no reply delay, no retries.
  const num = (key: string, current: number) => {
    const raw = formData.get(key);
    if (raw === null || String(raw).trim() === "") return current;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : current;
  };

  /**
   * A rate limit, floored at 1.
   *
   * This comment used to say a limit of 0 meant "no limit". It does not, and never did:
   * `exceedsLimit` in the worker is `used >= limit`, so a saved 0 blocks EVERY outbound message —
   * auto-replies, AI replies, and the manual replies an operator types in the chat inbox, which
   * then defer indefinitely. A self-refuting "limit reached (0/0)" in the logs is the only
   * symptom, and the comment sent whoever read it looking in the wrong place.
   *
   * Only the empty box was ever guarded. A deliberately typed 0 — exactly what somebody does
   * after reading "0 means no limit" — went straight through. The floor removes the footgun
   * outright: there is no legitimate use for a rate limit of zero, because the switch that turns
   * limits off is `rateLimitingEnabled`, sitting on this same form.
   */
  const limit = (key: string, current: number) => Math.max(1, num(key, current));

  await prisma.automationSettings.update({
    where: { id: "global" },
    data: {
      maxRepliesPerClientPerHour: limit("maxRepliesPerClientPerHour", current.maxRepliesPerClientPerHour),
      maxRepliesPerClientPerDay: limit("maxRepliesPerClientPerDay", current.maxRepliesPerClientPerDay),
      globalMaxPerMinute: limit("globalMaxPerMinute", current.globalMaxPerMinute),
      globalMaxPerHour: limit("globalMaxPerHour", current.globalMaxPerHour),
      globalMaxPerDay: limit("globalMaxPerDay", current.globalMaxPerDay),
      rateLimitingEnabled: formData.get("rateLimitingEnabled") === "on",
      defaultReplyDelayMinMs: num("defaultReplyDelayMinMs", current.defaultReplyDelayMinMs),
      defaultReplyDelayMaxMs: num("defaultReplyDelayMaxMs", current.defaultReplyDelayMaxMs),
      retryMaxAttempts: num("retryMaxAttempts", current.retryMaxAttempts),
      // Entered as seconds, stored as milliseconds — same reasoning as the broadcast delays: a
      // backoff list typed in thousandths invites a digit slip nobody notices until retries are
      // hammering a rate-limited number. An empty or unparseable list keeps the current schedule
      // rather than silently becoming "retry immediately".
      retryIntervalsMs: parseRetryIntervals(formData.get("retryIntervalsSeconds"), current.retryIntervalsMs),
      teamsWebhookUrl: String(formData.get("teamsWebhookUrl") ?? "").trim() || null,
      whatsappNotificationGroupIds: formData.getAll("whatsappNotificationGroupIds").map(String),
    },
  });

  revalidatePath(await projectPath("/settings"));
  return { success: true };
}
