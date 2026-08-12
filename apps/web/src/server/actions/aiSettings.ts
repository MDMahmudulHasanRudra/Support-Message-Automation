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
    },
    create: { id: "global" },
  });

  await logSystemEvent("INFO", "ai-learning", "AI Settings updated");
  revalidatePath("/ai-learning/settings");
  revalidatePath("/ai-learning");
  return { success: true };
}
