"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { logSystemEvent } from "@/server/logSystemEvent";

export interface AiSettingsFormState {
  error?: string;
  success?: boolean;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export async function updateAiSettings(
  _prevState: AiSettingsFormState,
  formData: FormData,
): Promise<AiSettingsFormState> {
  await requireSession();

  const flag = (key: string) => formData.get(key) === "on";
  const percent = (key: string, fallback: number) => {
    const raw = Number(formData.get(key));
    return Number.isFinite(raw) ? clampPercent(raw) : fallback;
  };
  const nonNegativeInt = (key: string, fallback: number) => {
    const raw = Number(formData.get(key));
    return Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : fallback;
  };
  // Only the two scopes the enum defines — anything else falls back to the conservative one
  // rather than being written through to the database unchecked.
  const scope = formData.get("aiAutomationScope") === "ALL_MONITORED_GROUPS" ? "ALL_MONITORED_GROUPS" : "PER_GROUP";
  // One WhatsApp group id per line, blanks dropped — the same shape the general notification
  // group field already uses.
  const takeoverNotifyGroupIds = String(formData.get("takeoverNotifyGroupIds") ?? "")
    .split(/[\r\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean);

  await prisma.aiSettings.upsert({
    where: { id: "global" },
    update: {
      aiEngineEnabled: flag("aiEngineEnabled"),
      learningEnabled: flag("learningEnabled"),
      autoResponseEnabled: flag("autoResponseEnabled"),
      screenshotResponseEnabled: flag("screenshotResponseEnabled"),
      chatLearningEnabled: flag("chatLearningEnabled"),
      softwareLearningEnabled: flag("softwareLearningEnabled"),
      requirementLearningEnabled: flag("requirementLearningEnabled"),
      announcementAiEnabled: flag("announcementAiEnabled"),
      duplicateSimilarityThreshold: percent("duplicateSimilarityThreshold", 95),
      learningConfidenceThreshold: percent("learningConfidenceThreshold", 90),
      autoApprovalThreshold: percent("autoApprovalThreshold", 95),
      humanReviewThreshold: percent("humanReviewThreshold", 70),
      autoResponseConfidenceThreshold: percent("autoResponseConfidenceThreshold", 90),
      aiReplyCooldownSeconds: nonNegativeInt("aiReplyCooldownSeconds", 300),
      humanTakeoverCooldownMinutes: nonNegativeInt("humanTakeoverCooldownMinutes", 30),
      aiAutomationScope: scope,
      aiRuleGenerationEnabled: flag("aiRuleGenerationEnabled"),
      aiRuleGenerationMinConfidence: percent("aiRuleGenerationMinConfidence", 95),
      takeoverNotifyGroupIds,
      knowledgeFromChatEnabled: flag("knowledgeFromChatEnabled"),
      knowledgeMinMessagesPerGroup: nonNegativeInt("knowledgeMinMessagesPerGroup", 25),
    },
    create: { id: "global" },
  });

  await logSystemEvent("INFO", "ai-learning", "AI Settings updated");
  revalidatePath("/ai-learning/settings");
  revalidatePath("/ai-learning");
  return { success: true };
}
