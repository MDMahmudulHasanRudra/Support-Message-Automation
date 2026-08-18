"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@support-automation/db";
import type { AiModelJob } from "@prisma/client";
import { requireSession } from "@/server/auth";
import { logSystemEvent } from "@/server/logSystemEvent";

export interface AiModelFormState {
  error?: string;
  success?: boolean;
}

const MODEL_JOBS: AiModelJob[] = ["LEARNING", "RESPONSE", "VISION", "DOCUMENT", "EMBEDDING", "ADMIN_ASSISTANT"];

function isModelJob(value: string): value is AiModelJob {
  return (MODEL_JOBS as string[]).includes(value);
}

export async function setAiModelConfig(_prevState: AiModelFormState, formData: FormData): Promise<AiModelFormState> {
  await requireSession();

  const jobRaw = String(formData.get("job") ?? "");
  const providerId = String(formData.get("providerId") ?? "").trim();
  const modelId = String(formData.get("modelId") ?? "").trim();

  if (!isModelJob(jobRaw)) return { error: "Invalid job." };
  if (!providerId) return { error: "Select a provider." };
  if (!modelId) return { error: "Model id is required." };

  const provider = await prisma.aiProvider.findUnique({ where: { id: providerId } });
  if (!provider) return { error: "Provider not found." };

  await prisma.aiModelConfig.upsert({
    where: { job: jobRaw },
    update: { providerId, modelId },
    create: { job: jobRaw, providerId, modelId },
  });

  await logSystemEvent("INFO", "ai-learning", `${jobRaw} model set to "${modelId}" on "${provider.name}"`);
  revalidatePath("/ai-learning/models");
  return { success: true };
}

export async function clearAiModelConfig(job: string): Promise<void> {
  await requireSession();
  if (!isModelJob(job)) return;
  await prisma.aiModelConfig.deleteMany({ where: { job } });
  revalidatePath("/ai-learning/models");
}
