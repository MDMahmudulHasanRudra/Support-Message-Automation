import { prisma, decryptSecret } from "@support-automation/db";
import { AI_PROVIDER_PROFILES, isOpenAiCompatibleKind } from "@support-automation/shared";
import type { AiModelJob } from "@prisma/client";
import { AnthropicClient } from "./AnthropicClient.js";
import { OpenAiCompatibleClient } from "./OpenAiCompatibleClient.js";
import type { AiClient } from "./AiClient.js";

/** OpenRouter asks callers to identify themselves; it uses these for its own rankings page. */
const OPENROUTER_HEADERS = {
  "HTTP-Referer": "https://github.com/support-message-automation",
  "X-Title": "Support Message Automation",
};

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
 * ANTHROPIC has its own SDK-backed client. OPENAI, OPENROUTER and OLLAMA all speak the standard
 * chat-completions protocol and share OpenAiCompatibleClient, differing only in default endpoint,
 * whether a key is sent, and how long a response may take. GOOGLE/CUSTOM remain reserved,
 * unimplemented enum values; a provider configured with either resolves to null here, same as any
 * other "not ready" state.
 */
export async function resolveAiClient(job: AiModelJob): Promise<AiClient | null> {
  const settings = await prisma.aiSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
  if (!settings.aiEngineEnabled) return null;

  const modelConfig = await prisma.aiModelConfig.findUnique({ where: { job }, include: { provider: true } });
  if (!modelConfig) return null;

  const provider = modelConfig.provider;
  if (provider.status !== "ACTIVE") return null;

  const profile = AI_PROVIDER_PROFILES[provider.kind as keyof typeof AI_PROVIDER_PROFILES];
  if (!profile?.implemented) return null;

  // Null only for a keyless local runtime. A hosted provider saved without a key is a
  // misconfiguration, not a reason to fire off an unauthenticated request.
  const apiKey = provider.apiKeyCiphertext ? decryptSecret(provider.apiKeyCiphertext) : null;
  if (profile.requiresApiKey && !apiKey) return null;

  if (provider.kind === "ANTHROPIC") {
    return new AnthropicClient(provider.id, modelConfig.modelId, apiKey!, provider.apiUrl);
  }

  if (isOpenAiCompatibleKind(provider.kind)) {
    return new OpenAiCompatibleClient(provider.id, modelConfig.modelId, {
      apiKey,
      baseURL: provider.apiUrl || profile.defaultApiUrl,
      extraHeaders: provider.kind === "OPENROUTER" ? OPENROUTER_HEADERS : undefined,
      // A model running on local hardware is genuinely slower than a hosted API.
      slowRuntime: provider.kind === "OLLAMA",
    });
  }

  return null; // GOOGLE/CUSTOM — no client implementation yet
}
