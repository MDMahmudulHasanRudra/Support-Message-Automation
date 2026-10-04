"use server";

import { revalidatePath } from "next/cache";
import {
  describeMediaRetention,
  MEDIA_CLEANUP_CONFIRMATION,
  MESSAGE_MEDIA_SETTING_FIELD,
  mediaRetentionCutoff,
  parseMediaRetentionDays,
  type MediaStorageSwitches,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { checkPermission } from "@/server/authorize";
import { activeProjectId } from "@/server/projectContext";
import { projectPath } from "@/server/projectPaths";
import { logSystemEvent } from "@/server/logSystemEvent";
import { previewMediaCleanupCandidates } from "@/server/mediaStorageReports";

/**
 * Settings → Message & Media Storage (MEDIA_STORAGE.md). Nothing here touches a file: settings are
 * a row, and a cleanup is a job row the worker carries out in batches. That is what keeps a
 * "delete everything older than three months" from ever running inside a web request.
 *
 * Gated on `settings.edit` — the key every other Automation & Safety setting uses.
 */

const PAGE = "/settings/media-storage";
const ACTIVE = ["SCHEDULED", "RUNNING"] as const;

export interface MediaStorageSettingsState {
  saved?: boolean;
  error?: string;
  /** What changed about retention, in words, when it did. */
  retentionNote?: string;
}

function readRetention(formData: FormData): { days: number | null } | { error: string } {
  const choice = String(formData.get("retention") ?? "never");
  if (choice === "custom") return parseMediaRetentionDays(String(formData.get("retentionCustomDays") ?? ""));
  return parseMediaRetentionDays(choice);
}

export async function saveMediaStorageSettings(_prev: MediaStorageSettingsState, formData: FormData): Promise<MediaStorageSettingsState> {
  const granted = await checkPermission("settings.edit");
  if ("denied" in granted) return { error: granted.denied };

  const retention = readRetention(formData);
  if ("error" in retention) return { error: retention.error };

  const switches = Object.fromEntries(
    Object.values(MESSAGE_MEDIA_SETTING_FIELD).map((field) => [field, formData.get(field) === "on"]),
  ) as MediaStorageSwitches;

  const before = await prisma.mediaStorageSettings.findUnique({ where: { id: "global" } });
  const retentionChanged = (before?.retentionDays ?? null) !== retention.days;

  await prisma.mediaStorageSettings.upsert({
    where: { id: "global" },
    update: { ...switches, retentionDays: retention.days, updatedById: granted.session.userId },
    create: { id: "global", ...switches, retentionDays: retention.days, updatedById: granted.session.userId },
  });

  let retentionNote: string | undefined;
  if (retentionChanged) {
    // A retention job removes what the setting said when it was made, so one in flight is stopped
    // now rather than left to finish under a rule nobody holds any more. Manual cleanups an admin
    // started are theirs and are left alone.
    const { count } = await prisma.mediaCleanupJob.updateMany({
      where: { trigger: "RETENTION", status: { in: [...ACTIVE] } },
      data: { status: "CANCELLED", lastError: "The retention setting changed, so this cleanup stopped.", completedAt: new Date() },
    });
    retentionNote =
      retention.days === null
        ? `Retention is now "keep everything". Nothing will be removed by retention${count ? `, and ${count} scheduled retention cleanup was stopped` : ""}. Files already removed cannot be restored.`
        : `Retention is now "${describeMediaRetention(retention.days)}". Files older than that are removed in the background, in batches, starting within a few minutes. Message text is never removed.`;
    await logSystemEvent(
      "WARN",
      "media",
      `Media retention changed to "${describeMediaRetention(retention.days)}"`,
      { from: before?.retentionDays ?? null, to: retention.days, cancelledRetentionJobs: count },
      { actorUserId: granted.session.userId, targetType: "MediaStorageSettings" },
    );
  }
  await logSystemEvent("INFO", "media", "Media storage settings saved", { ...switches, retentionDays: retention.days }, {
    actorUserId: granted.session.userId,
    targetType: "MediaStorageSettings",
  });

  revalidatePath(await projectPath(PAGE));
  return { saved: true, retentionNote };
}

export interface MediaCleanupPreview {
  error?: string;
  olderThanDays?: number;
  olderThan?: string;
  files?: number;
  bytes?: number;
}

/** What "delete media older than N days" would remove right now. Reads only. */
export async function previewMediaCleanup(olderThanDays: string): Promise<MediaCleanupPreview> {
  const granted = await checkPermission("settings.edit");
  if ("denied" in granted) return { error: granted.denied };
  const parsed = parseMediaRetentionDays(olderThanDays);
  if ("error" in parsed) return { error: parsed.error };
  if (parsed.days === null) return { error: "Choose how old media must be before it is removed." };
  const olderThan = mediaRetentionCutoff(new Date(), parsed.days);
  const { files, bytes } = await previewMediaCleanupCandidates(olderThan);
  return { olderThanDays: parsed.days, olderThan: olderThan.toISOString(), files, bytes };
}

export interface StartMediaCleanupResult {
  error?: string;
  jobId?: string;
}

/**
 * Schedules a manual cleanup. One active cleanup per project, decided under a lock so two clicks
 * (or two admins) cannot start two.
 */
export async function startMediaCleanup(input: { olderThanDays: string; confirmation: string }): Promise<StartMediaCleanupResult> {
  const granted = await checkPermission("settings.edit");
  if ("denied" in granted) return { error: granted.denied };
  // Checked here as well as in the dialog: the dialog is a convenience a direct call skips.
  if (input.confirmation.trim() !== MEDIA_CLEANUP_CONFIRMATION) {
    return { error: `Type ${MEDIA_CLEANUP_CONFIRMATION} to confirm. Nothing was removed.` };
  }
  const parsed = parseMediaRetentionDays(input.olderThanDays);
  if ("error" in parsed) return { error: parsed.error };
  if (parsed.days === null) return { error: "Choose how old media must be before it is removed." };
  const olderThan = mediaRetentionCutoff(new Date(), parsed.days);
  const projectId = await activeProjectId();

  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`media-cleanup:${projectId}`})::bigint)`;
    const active = await tx.mediaCleanupJob.findFirst({ where: { status: { in: [...ACTIVE] } }, select: { id: true } });
    if (active) return { error: "A media cleanup is already scheduled or running. Wait for it to finish, or cancel it first." };
    const job = await tx.mediaCleanupJob.create({
      data: { trigger: "MANUAL", olderThan, requestedById: granted.session.userId },
      select: { id: true },
    });
    return { jobId: job.id };
  });
  if ("error" in outcome) return outcome;

  await logSystemEvent(
    "WARN",
    "media",
    `Manual media cleanup scheduled: files older than ${parsed.days} days`,
    { olderThan: olderThan.toISOString() },
    { actorUserId: granted.session.userId, targetType: "MediaCleanupJob", targetId: outcome.jobId },
  );
  revalidatePath(await projectPath(PAGE));
  return outcome;
}

/** Stops a cleanup before its next batch. Files already removed stay removed. */
export async function cancelMediaCleanup(jobId: string): Promise<{ error?: string }> {
  const granted = await checkPermission("settings.edit");
  if ("denied" in granted) return { error: granted.denied };
  const { count } = await prisma.mediaCleanupJob.updateMany({
    where: { id: jobId, status: { in: [...ACTIVE] } },
    data: { status: "CANCELLED", lastError: "Cancelled on Settings. Files already removed stay removed.", completedAt: new Date() },
  });
  if (count === 0) return { error: "That cleanup has already finished." };
  await logSystemEvent("INFO", "media", "Media cleanup cancelled", {}, { actorUserId: granted.session.userId, targetType: "MediaCleanupJob", targetId: jobId });
  revalidatePath(await projectPath(PAGE));
  return {};
}
