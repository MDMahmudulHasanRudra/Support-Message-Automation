import { prisma } from "@/server/db";
import Anthropic from "@anthropic-ai/sdk";
import { decryptSecret } from "@support-automation/db";

/**
 * Bounds one Anthropic request. The chat loop runs up to MAX_ITERATIONS (chat.ts) requests inside
 * a single server action, so this ceiling is what keeps the worst case at a couple of minutes
 * rather than unbounded. Mirrors AnthropicClient's REQUEST_TIMEOUT_MS (packages/ai-client).
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Why no Admin Assistant client could be built. These used to be one shared `null`, so chat.ts
 * told an admin to go and configure the very thing they had already configured — the actual
 * problem (an OpenRouter provider in an Anthropic-only slot, or a disabled provider) was
 * indistinguishable from "nothing set up yet". Shaped after resolveAiClientResult()'s
 * discriminated result in packages/ai-client/src/resolveAiClient.ts.
 */
export type AiAdminUnavailableReason =
  | "ENGINE_DISABLED"
  | "NO_MODEL_CONFIGURED"
  | "PROVIDER_INACTIVE"
  | "PROVIDER_NOT_ANTHROPIC"
  | "API_KEY_MISSING";

export interface AiAdminClientResolution {
  client: Anthropic | null;
  modelId: string | null;
  reason: AiAdminUnavailableReason | null;
  /** Actionable prose for the chat panel; null when a client was resolved. */
  detail: string | null;
}

/**
 * Resolves the Admin Assistant's own Anthropic client + model id. Deliberately NOT
 * resolveAiClient() (packages/ai-client) — that helper's AiClient interface is intentionally
 * text-only/no-tools (a safety invariant for the Conversation Learning job that must not be
 * loosened). The Admin Assistant needs real multi-turn tool-calling, so it talks to the Anthropic
 * SDK directly here — matching the precedent already set by aiProviders.ts's connectivity-test
 * call, which also bypasses ai-client for the same reason.
 */
export async function resolveAiAdminClient(): Promise<AiAdminClientResolution> {
  const settings = await prisma.aiSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
  if (!settings.aiEngineEnabled) {
    return unavailable("ENGINE_DISABLED", "The AI Engine master switch is off. Turn it on in AI Settings.");
  }

  const modelConfig = await prisma.aiModelConfig.findUnique({
    where: { job: "ADMIN_ASSISTANT" },
    include: { provider: true },
  });
  if (!modelConfig) {
    return unavailable(
      "NO_MODEL_CONFIGURED",
      'No provider is assigned to the "Admin Assistant Model" job yet. Add an Anthropic provider on the AI Providers page, then assign it on the AI Models page.',
    );
  }

  const provider = modelConfig.provider;
  if (provider.status !== "ACTIVE") {
    return unavailable(
      "PROVIDER_INACTIVE",
      `The assigned provider "${provider.name}" is disabled. Re-enable it on the AI Providers page.`,
    );
  }
  // Anthropic only, and deliberately so: the Assistant needs real multi-turn tool-calling, and the
  // OpenAI-compatible tool protocol is a different wire format, not a base-URL swap. setAiModelConfig()
  // now rejects this assignment at save time; this stays as the guard for rows saved before it did.
  if (provider.kind !== "ANTHROPIC") {
    return unavailable(
      "PROVIDER_NOT_ANTHROPIC",
      `The Admin Assistant is assigned to "${provider.name}", which is a ${provider.kind} provider. This chat needs Anthropic's tool-calling API — reassign the Admin Assistant Model job to an Anthropic provider on the AI Models page. Every other AI feature can keep using ${provider.kind}.`,
    );
  }
  if (!provider.apiKeyCiphertext) {
    return unavailable(
      "API_KEY_MISSING",
      `The assigned provider "${provider.name}" has no API key saved. Edit it on the AI Providers page and paste an Anthropic key.`,
    );
  }

  const apiKey = decryptSecret(provider.apiKeyCiphertext);
  return {
    // timeout + maxRetries together, for the reason AnthropicClient documents: the SDK retries a
    // per-attempt timeout by default (up to 2x), which would turn each of the loop's iterations
    // into a 90s worst case. A transient failure here surfaces to the admin, who is sitting in
    // front of the chat and can simply ask again — unlike the pipeline, this path has a human
    // retry loop already, so it does not need a machine one.
    client: new Anthropic({
      apiKey,
      baseURL: provider.apiUrl || undefined,
      timeout: REQUEST_TIMEOUT_MS,
      maxRetries: 0,
    }),
    modelId: modelConfig.modelId,
    reason: null,
    detail: null,
  };
}

function unavailable(reason: AiAdminUnavailableReason, detail: string): AiAdminClientResolution {
  return { client: null, modelId: null, reason, detail };
}
