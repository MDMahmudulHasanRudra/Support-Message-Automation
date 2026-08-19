"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";

/** Dashboard "Sync Now" button — mirrors triggerAiAnalysisBatch()'s exact idempotency pattern
 * (never queue a second command of the same type while one is already pending/processing).
 * Account-agnostic: there is at most one connected TeamsAccount (see commandProcessor.ts's
 * special-case handling for TEAMS_SYNC_NOW). */
export async function triggerTeamsSyncNow(): Promise<void> {
  await requireSession();
  const existing = await prisma.workerCommand.findFirst({
    where: { type: "TEAMS_SYNC_NOW", status: { in: ["PENDING", "PROCESSING"] } },
  });
  if (!existing) {
    await prisma.workerCommand.create({ data: { type: "TEAMS_SYNC_NOW" } });
  }
  revalidatePath("/integrations/teams");
}

/** Disconnects the Microsoft account — clears the stored (encrypted) tokens but keeps the synced
 * Teams/channel/message history and every SupportIssue/IssueResolutionEvent audit row intact
 * (soft-disconnect, same "never destroy history" convention as WhatsApp account logout). */
export async function disconnectTeamsAccount(): Promise<void> {
  await requireSession();
  await prisma.teamsAccount.update({
    where: { id: "global" },
    data: {
      status: "DISCONNECTED",
      accessTokenCiphertext: null,
      refreshTokenCiphertext: null,
      tokenExpiresAt: null,
      lastSyncError: null,
    },
  });
  revalidatePath("/integrations/teams");
}

/**
 * "Manage Teams & Channels" — lets an admin narrow which discovered Teams/Channels are actually
 * message-synced, without touching per-Issue links (an Issue's own teamsChannelId always still
 * gets synced regardless of this coarser toggle — see graphSync.ts's inAutomationScope check).
 * The form submits the full set of team/channel ids that were rendered (hidden `allTeamIds`/
 * `allChannelIds`, comma-separated) alongside which ones are checked, so an unchecked box
 * correctly turns a team/channel OFF rather than just being silently absent from the request.
 */
export async function updateTeamsAutomationScope(formData: FormData): Promise<void> {
  await requireSession();

  const allTeamIds = String(formData.get("allTeamIds") ?? "").split(",").filter(Boolean);
  const allChannelIds = String(formData.get("allChannelIds") ?? "").split(",").filter(Boolean);

  await prisma.$transaction([
    ...allTeamIds.map((id) =>
      prisma.teamsTeam.update({ where: { id }, data: { isEnabledForAutomation: formData.get(`team_${id}`) === "on" } }),
    ),
    ...allChannelIds.map((id) =>
      prisma.teamsChannel.update({ where: { id }, data: { isEnabledForAutomation: formData.get(`channel_${id}`) === "on" } }),
    ),
  ]);

  revalidatePath("/integrations/teams/manage");
  revalidatePath("/integrations/teams");
}

export interface TeamsIntegrationSettingsFormState {
  error?: string;
  success?: boolean;
}

export async function saveTeamsIntegrationSettings(
  _prevState: TeamsIntegrationSettingsFormState,
  formData: FormData,
): Promise<TeamsIntegrationSettingsFormState> {
  await requireSession();

  const notificationTemplate = String(formData.get("notificationTemplate") ?? "").trim();
  const pollingIntervalMinutes = Number(formData.get("pollingIntervalMinutes"));
  if (!notificationTemplate) return { error: "Notification template is required." };
  if (!Number.isFinite(pollingIntervalMinutes) || pollingIntervalMinutes < 1) {
    return { error: "Polling interval must be at least 1 minute." };
  }

  await prisma.teamsIntegrationSettings.upsert({
    where: { id: "global" },
    update: {
      enableResolutionDetection: formData.get("enableResolutionDetection") === "on",
      enableCustomerNotification: formData.get("enableCustomerNotification") === "on",
      notificationTemplate,
      pollingIntervalMinutes,
    },
    create: {
      id: "global",
      enableResolutionDetection: formData.get("enableResolutionDetection") === "on",
      enableCustomerNotification: formData.get("enableCustomerNotification") === "on",
      notificationTemplate,
      pollingIntervalMinutes,
    },
  });

  revalidatePath("/integrations/teams/settings");
  return { success: true };
}
