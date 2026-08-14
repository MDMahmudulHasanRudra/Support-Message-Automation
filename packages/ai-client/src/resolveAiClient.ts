import { prisma, decryptSecret } from "@support-automation/db";
import type { AiModelJob } from "@prisma/client";
import { AnthropicClient } from "./AnthropicClient.js";
import type { AiClient } from "./AiClient.js";

/**
 * Resolves the configured AiClient for a given job (e.g. "LEARNING"), or null if AI shouldn't run
 * right now for ANY reason — every caller must treat null as "skip AI, stay deterministic," never
 * as an error to surface. Never throws for a missing/misconfigured/disabled provider; only a
 * genuinely broken AI_CREDENTIALS_ENCRYPTION_KEY (decryptSecret's own failure mode) escapes as an
 * exception, since that indicates a real deployment misconfiguration rather than "AI just isn't
 * turned on right now."
 */
export async function resolveAiClient(job: AiModelJob): Promise<AiClient | null> {
  const settings = await prisma.aiSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
  if (!settings.aiEngineEnabled || !settings.learningEnabled) return null;

  const modelConfig = await prisma.aiModelConfig.findUnique({ where: { job }, include: { provider: true } });
  if (!modelConfig) return null;

  const provider = modelConfig.provider;
  if (provider.status !== "ACTIVE") return null;
  if (provider.kind !== "ANTHROPIC") return null; // only kind implemented so far — see AnthropicClient's doc comment

  const apiKey = decryptSecret(provider.apiKeyCiphertext);
  return new AnthropicClient(provider.id, modelConfig.modelId, apiKey, provider.apiUrl);
}
