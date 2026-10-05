"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { checkPermission } from "@/server/authorize";
import { projectPath } from "@/server/projectPaths";
import { logSystemEvent } from "@/server/logSystemEvent";
import { diffMoodSettings, parseMoodSettingsForm } from "@/lib/moodDetectionForm";
import { getMoodSettingsView } from "@/server/moodDetectionReports";

/**
 * Settings → Mood Detection (MOOD_DETECTION.md). Gated on `settings.edit`, the key every other
 * Automation & Safety setting uses; the scoped client confines the row to the URL's project.
 * Every save is audited with what changed, from what, to what.
 */

const PAGE = "/settings/mood-detection";

export interface MoodSettingsState {
  saved?: boolean;
  error?: string;
  /** How many fields changed, for the confirmation. */
  changed?: number;
}

export async function saveMoodDetectionSettings(_prev: MoodSettingsState, formData: FormData): Promise<MoodSettingsState> {
  const granted = await checkPermission("settings.edit");
  if ("denied" in granted) return { error: granted.denied };

  const parsed = parseMoodSettingsForm(formData);
  if ("error" in parsed) return { error: parsed.error };
  const value = parsed.value;

  // An internal escalation group must be a group of THIS project: an id from anywhere else (a
  // crafted form, a stale tab after a group left) is dropped rather than saved.
  if (value.internalGroupIds.length > 0) {
    const known = await prisma.whatsAppGroup.findMany({
      where: { whatsappGroupId: { in: value.internalGroupIds }, isActive: true },
      select: { whatsappGroupId: true },
    });
    const knownIds = new Set(known.map((g) => g.whatsappGroupId));
    value.internalGroupIds = value.internalGroupIds.filter((id) => knownIds.has(id));
  }

  const before = await getMoodSettingsView();
  const changes = diffMoodSettings(before, value);

  const data = {
    enabled: value.enabled,
    analyzeText: value.analyzeText,
    analyzeEmoji: value.analyzeEmoji,
    analyzeStickers: value.analyzeStickers,
    useAiClassification: value.useAiClassification,
    sensitivity: value.sensitivity,
    minConfidence: value.minConfidence,
    cooldownMinutes: value.cooldownMinutes,
    internalGroupIds: value.internalGroupIds,
    policies: value.policies as unknown as Prisma.InputJsonValue,
    unassignedMention: value.unassignedMention,
    skipCustomerMessageWhenUnassigned: value.skipCustomerMessageWhenUnassigned,
    requireHumanHours: value.requireHumanHours,
    updatedById: granted.session.userId,
  };
  await prisma.moodDetectionSettings.upsert({ where: { id: "global" }, update: data, create: { id: "global", ...data } });

  const count = Object.keys(changes).length;
  if (count > 0) {
    const switched = "enabled" in changes;
    await logSystemEvent(
      switched ? "WARN" : "INFO",
      "mood-detection",
      switched ? `Mood Detection switched ${value.enabled ? "on" : "off"}` : "Mood Detection settings changed",
      { changes },
      { actorUserId: granted.session.userId, targetType: "MoodDetectionSettings" },
    );
  }

  revalidatePath(await projectPath(PAGE));
  return { saved: true, changed: count };
}
