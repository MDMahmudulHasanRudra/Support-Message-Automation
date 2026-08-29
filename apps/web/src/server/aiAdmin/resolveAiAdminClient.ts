import Anthropic from "@anthropic-ai/sdk";
import { prisma, decryptSecret } from "@support-automation/db";

/**
 * Resolves the Admin Assistant's own Anthropic client + model id, or null if it isn't configured
 * yet. Deliberately NOT resolveAiClient() (packages/ai-client) — that helper gates on
 * `learningEnabled`, a flag specific to the Conversation Learning job, and its AiClient interface
 * is intentionally text-only/no-tools (a safety invariant for that job that must not be loosened).
 * The Admin Assistant needs real multi-turn tool-calling, so it talks to the Anthropic SDK
 * directly here — matching the precedent already set by aiProviders.ts's connectivity-test call,
 * which also bypasses ai-client for the same reason (needs SDK features ai-client doesn't expose).
 */
export async function resolveAiAdminClient(): Promise<{ client: Anthropic; modelId: string } | null> {
  const settings = await prisma.aiSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
  if (!settings.aiEngineEnabled) return null;

  const modelConfig = await prisma.aiModelConfig.findUnique({
    where: { job: "ADMIN_ASSISTANT" },
    include: { provider: true },
  });
  if (!modelConfig) return null;

  const provider = modelConfig.provider;
  if (provider.status !== "ACTIVE") return null;
  // Anthropic only, and deliberately so: the Assistant needs real multi-turn tool-calling,
  // and the OpenAI-compatible tool protocol is a different wire format, not a base-URL swap.
  // Point the ADMIN_ASSISTANT slot at an Anthropic provider even when everything else runs
  // through OpenRouter or a local model.
  if (provider.kind !== "ANTHROPIC") return null;
  // Null would mean a keyless provider was assigned to this slot — not valid for Anthropic.
  if (!provider.apiKeyCiphertext) return null;

  const apiKey = decryptSecret(provider.apiKeyCiphertext);
  return {
    client: new Anthropic({ apiKey, baseURL: provider.apiUrl || undefined }),
    modelId: modelConfig.modelId,
  };
}
