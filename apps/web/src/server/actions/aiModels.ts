"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@support-automation/db";
import type { AiModelJob } from "@prisma/client";
import { aiProviderProfile } from "@support-automation/shared";
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

  // Every other slot goes through packages/ai-client, which is provider-agnostic. The Admin
  // Assistant does not: it is built on Anthropic's tool-calling wire format
  // (Anthropic.Tool / ToolUseBlock / ToolResultBlockParam in server/aiAdmin/chat.ts), which the
  // OpenAI-compatible protocol expresses completely differently — it is not a base-URL swap.
  // Assigning anything else used to save cleanly and leave the widget insisting it was
  // "not configured yet" forever, with nothing anywhere naming the real reason.
  if (jobRaw === "ADMIN_ASSISTANT" && provider.kind !== "ANTHROPIC") {
    const label = aiProviderProfile(provider.kind)?.label ?? provider.kind;
    return {
      error: `The Admin Assistant needs Anthropic's tool-calling API, and "${provider.name}" is ${label}. Add an Anthropic provider and assign that here. Every other job slot works with any provider type.`,
    };
  }

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
