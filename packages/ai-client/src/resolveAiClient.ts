import { prisma, decryptSecret } from "@support-automation/db";
import type { AiModelJob } from "@prisma/client";
import { AnthropicClient } from "./AnthropicClient.js";
import { OpenAiCompatibleClient } from "./OpenAiCompatibleClient.js";
import type { AiClient } from "./AiClient.js";

/**
 * Resolves the configured AiClient for a given job (e.g. "LEARNING"), or null if AI shouldn't run
 * right now for ANY reason — every caller must treat null as "skip AI, stay deterministic," never
 * as an error to surface. Never throws for a missing/misconfigured/disabled provider; only a
 * genuinely broken AI_CREDENTIALS_ENCRYPTION_KEY (decryptSecret's own failure mode) escapes as an
 * exception, since that indicates a real deployment misconfiguration rather than "AI just isn't
 * turned on right now."
 *
 * Gates on `aiEngineEnabled` only — the global "is AI allowed to run at all" master switch.
 * Per-job gating belongs to the job: `AiSettings.learningEnabled` is specific to Conversation
 * Learning, and aiAnalysisJob.ts checks it explicitly before it ever calls here. Gating on it in
 * this shared helper made the Hybrid AI Automation fallback (job "RESPONSE") unreachable whenever
 * Conversation Learning was off — which is the default — so every AI-eligible message recorded an
 * AI_UNAVAILABLE human fallback and fired an alert instead of replying, with nothing in the
 * dashboard explaining why. Do not re-add a job-specific flag to this function.
 *
 * Two AiProviderKind values have a real client implementation today: ANTHROPIC and OPENAI (the
 * latter covers any endpoint speaking the standard OpenAI-compatible chat-completions protocol —
 * OpenAI's own API, a self-hosted/local runtime, or a custom internal proxy — see
 * OpenAiCompatibleClient's doc comment). GOOGLE/CUSTOM remain reserved, unimplemented enum values;
 * a provider configured with either resolves to null here, same as any other "not ready" state.
 */
export async function resolveAiClient(job: AiModelJob): Promise<AiClient | null> {
  const settings = await prisma.aiSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
  if (!settings.aiEngineEnabled) return null;

  const modelConfig = await prisma.aiModelConfig.findUnique({ where: { job }, include: { provider: true } });
  if (!modelConfig) return null;

  const provider = modelConfig.provider;
  if (provider.status !== "ACTIVE") return null;

  const apiKey = decryptSecret(provider.apiKeyCiphertext);
  if (provider.kind === "ANTHROPIC") {
    return new AnthropicClient(provider.id, modelConfig.modelId, apiKey, provider.apiUrl);
  }
  if (provider.kind === "OPENAI") {
    return new OpenAiCompatibleClient(provider.id, modelConfig.modelId, apiKey, provider.apiUrl);
  }
  return null; // GOOGLE/CUSTOM — no client implementation yet
}
