import { prisma, decryptSecret } from "@support-automation/db";
import { AI_PROVIDER_PROFILES, isOpenAiCompatibleKind, openRouterAttributionHeaders } from "@support-automation/shared";
import type { AiModelJob } from "@prisma/client";
import { AnthropicClient } from "./AnthropicClient.js";
import { OpenAiCompatibleClient } from "./OpenAiCompatibleClient.js";
import { PROVIDER_HEALTH_LOG_SCOPE, reportProviderCallOutcome } from "./providerHealth.js";
import type { AiClient } from "./AiClient.js";
import type { AiCallOutcome } from "./types.js";

/**
 * Why no client could be built. Every one of these used to be a bare `null`, and the RESPONSE job
 * collapsed all of them into a single "AI_UNAVAILABLE" reason — so an admin staring at a silent
 * assistant could not tell "someone switched the engine off" from "the key never got saved".
 */
export type AiClientUnavailableReason =
  | "ENGINE_DISABLED"
  | "NO_MODEL_CONFIGURED"
  | "PROVIDER_INACTIVE"
  | "PROVIDER_KIND_UNKNOWN"
  | "PROVIDER_KIND_UNIMPLEMENTED"
  | "API_KEY_MISSING"
  | "NO_CLIENT_FOR_KIND";

export interface AiClientResolution {
  client: AiClient | null;
  reason: AiClientUnavailableReason | null;
  /** Plain language for the dashboard; null when a client was resolved. */
  detail: string | null;
  providerId: string | null;
}

/** Deliberate operational states log as INFO; the rest are misconfigurations worth a WARN. */
const REASON_IS_EXPECTED: Record<AiClientUnavailableReason, boolean> = {
  ENGINE_DISABLED: true,
  NO_MODEL_CONFIGURED: false,
  PROVIDER_INACTIVE: false,
  PROVIDER_KIND_UNKNOWN: false,
  PROVIDER_KIND_UNIMPLEMENTED: false,
  API_KEY_MISSING: false,
  NO_CLIENT_FOR_KIND: false,
};

/** The RESPONSE job resolves once per unmatched message; one log line per cause per window is enough. */
const LOG_THROTTLE_MS = 10 * 60_000;
const lastLoggedAt = new Map<string, number>();

/**
 * Resolves the configured AiClient for a given job (e.g. "LEARNING"), or null if AI shouldn't run
 * right now for ANY reason — every caller must treat null as "skip AI, stay deterministic," never
 * as an error to surface. Never throws for a missing/misconfigured/disabled provider; only a
 * genuinely broken AI_CREDENTIALS_ENCRYPTION_KEY (decryptSecret's own failure mode) escapes as an
 * exception, since that indicates a real deployment misconfiguration rather than "AI just isn't
 * turned on right now."
 *
 * Kept as the bare-null signature every existing caller already uses. New callers that want to
 * record or display WHY should call resolveAiClientResult() instead.
 */
export async function resolveAiClient(job: AiModelJob): Promise<AiClient | null> {
  const resolution = await resolveAiClientResult(job);
  return resolution.client;
}

/**
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
 * unimplemented enum values; a provider configured with either resolves to no client here, same as
 * any other "not ready" state.
 */
export async function resolveAiClientResult(job: AiModelJob): Promise<AiClientResolution> {
  const settings = await prisma.aiSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
  if (!settings.aiEngineEnabled) {
    return unavailable(job, "ENGINE_DISABLED", "The AI engine master switch is off (AI Settings).", null);
  }

  const modelConfig = await prisma.aiModelConfig.findUnique({ where: { job }, include: { provider: true } });
  if (!modelConfig) {
    return unavailable(job, "NO_MODEL_CONFIGURED", `No provider/model is assigned to the ${job} job (AI Models).`, null);
  }

  const provider = modelConfig.provider;
  if (provider.status !== "ACTIVE") {
    return unavailable(job, "PROVIDER_INACTIVE", `Provider "${provider.name}" is disabled.`, provider.id);
  }

  const profile = AI_PROVIDER_PROFILES[provider.kind as keyof typeof AI_PROVIDER_PROFILES];
  if (!profile) {
    return unavailable(job, "PROVIDER_KIND_UNKNOWN", `Provider "${provider.name}" has an unrecognised type.`, provider.id);
  }
  if (!profile.implemented) {
    return unavailable(
      job,
      "PROVIDER_KIND_UNIMPLEMENTED",
      `${profile.label} is not implemented yet — reassign the ${job} job to a supported provider.`,
      provider.id,
    );
  }

  // Null only for a keyless local runtime. A hosted provider saved without a key is a
  // misconfiguration, not a reason to fire off an unauthenticated request.
  const apiKey = provider.apiKeyCiphertext ? decryptSecret(provider.apiKeyCiphertext) : null;
  if (profile.requiresApiKey && !apiKey) {
    return unavailable(job, "API_KEY_MISSING", `Provider "${provider.name}" has no API key saved.`, provider.id);
  }

  const onOutcome = (outcome: AiCallOutcome) => reportProviderCallOutcome(provider.id, outcome);

  if (provider.kind === "ANTHROPIC") {
    return {
      client: new AnthropicClient(provider.id, modelConfig.modelId, apiKey!, {
        baseURL: provider.apiUrl,
        onOutcome,
      }),
      reason: null,
      detail: null,
      providerId: provider.id,
    };
  }

  if (isOpenAiCompatibleKind(provider.kind)) {
    return {
      client: new OpenAiCompatibleClient(provider.id, modelConfig.modelId, {
        apiKey,
        baseURL: provider.apiUrl || profile.defaultApiUrl,
        // OpenRouter attributes traffic by this pair; it is env-configurable so a deployment is
        // credited to itself rather than to a placeholder URL.
        extraHeaders: provider.kind === "OPENROUTER" ? openRouterAttributionHeaders() : undefined,
        // A model running on local hardware is genuinely slower than a hosted API.
        slowRuntime: provider.kind === "OLLAMA",
        onOutcome,
      }),
      reason: null,
      detail: null,
      providerId: provider.id,
    };
  }

  return unavailable(job, "NO_CLIENT_FOR_KIND", `No client implementation exists for ${provider.kind}.`, provider.id);
}

function unavailable(
  job: AiModelJob,
  reason: AiClientUnavailableReason,
  detail: string,
  providerId: string | null,
): AiClientResolution {
  logUnavailable(job, reason, detail, providerId);
  return { client: null, reason, detail, providerId };
}

/** Fire-and-forget, throttled: the point is an admin can find the cause, not a log flood. */
function logUnavailable(
  job: AiModelJob,
  reason: AiClientUnavailableReason,
  detail: string,
  providerId: string | null,
): void {
  const key = `${job}:${reason}`;
  const previous = lastLoggedAt.get(key);
  if (previous && Date.now() - previous < LOG_THROTTLE_MS) return;
  lastLoggedAt.set(key, Date.now());

  void prisma.systemLog
    .create({
      data: {
        level: REASON_IS_EXPECTED[reason] ? "INFO" : "WARN",
        scope: PROVIDER_HEALTH_LOG_SCOPE,
        message: `AI unavailable for ${job}: ${detail}`,
        metadata: { job, reason, providerId },
      },
    })
    .catch((err) => {
      console.error("[ai-client] failed to log AI unavailability", err);
    });
}
