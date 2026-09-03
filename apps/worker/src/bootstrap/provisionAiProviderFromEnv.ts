import { prisma, encryptSecret } from "@support-automation/db";
import { AI_PROVIDER_PROFILES } from "@support-automation/shared";
import { logSystemEvent } from "../logging/logSystemEvent.js";

/**
 * Turns AI credentials supplied in the environment into a real, usable AI provider on boot.
 *
 * Without this, putting `OPENROUTER_API_KEY` in `.env` does nothing at all: every AI feature in
 * this app resolves its client from the `AiProvider` table, and that table is only written by the
 * dashboard's provider form. A key in the environment and no row in the table looks configured
 * and behaves as though nothing was configured — the kind of gap that costs an afternoon.
 *
 * Three rules keep this safe to run on every boot:
 *
 *  - **Never overwrite.** If a provider of this kind already exists, this does nothing. Whatever
 *    an admin set in the dashboard outranks the environment, always. The environment seeds an
 *    empty install; it does not reconfigure a running one.
 *  - **Never steal a job slot.** An `AiModelConfig` is only created for a job that has none. A
 *    deployment already routing RESPONSE to Anthropic keeps doing so.
 *  - **Never fatal.** A failure here logs and returns; the worker still starts.
 *
 * The key is encrypted with the same `AI_CREDENTIALS_ENCRYPTION_KEY` the dashboard uses, so a
 * provider created here is indistinguishable from one created by hand.
 */

/** Which jobs an env-provisioned provider should serve if nothing else already does. */
const JOBS_TO_FILL = ["LEARNING", "RESPONSE"] as const;

export async function provisionAiProviderFromEnv(): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  const modelId = process.env.OPENROUTER_MODEL?.trim();
  if (!apiKey || !modelId) return;

  try {
    const existing = await prisma.aiProvider.findFirst({ where: { kind: "OPENROUTER" } });
    if (existing) {
      await ensureModelConfigs(existing.id, modelId);
      return;
    }

    const provider = await prisma.aiProvider.create({
      data: {
        name: "OpenRouter (from environment)",
        kind: "OPENROUTER",
        apiUrl: AI_PROVIDER_PROFILES.OPENROUTER.defaultApiUrl,
        apiKeyCiphertext: encryptSecret(apiKey),
        status: "ACTIVE",
        priority: 10,
      },
    });
    await ensureModelConfigs(provider.id, modelId);

    console.log(`[bootstrap] provisioned OpenRouter provider with model "${modelId}"`);
    await logSystemEvent("INFO", "bootstrap", "Configured an OpenRouter provider from the environment", { modelId });
  } catch (err) {
    // A missing/short AI_CREDENTIALS_ENCRYPTION_KEY is the likely cause and it is worth saying so
    // plainly, but it must not stop WhatsApp automation from starting.
    console.warn("[bootstrap] could not provision the AI provider from the environment —", (err as Error).message);
  }
}

/**
 * Fills only the job slots nobody has claimed, and repairs one specific mis-entry.
 *
 * The repair exists because it was found in production: every job slot had a `modelId` of
 * `"OPENROUTER"` — the provider *kind* typed into the model field. OpenRouter answers that with
 * `"OPENROUTER is not a valid model ID"`, so every AI feature in the deployment was dead, silently,
 * with the dashboard showing a green ACTIVE provider throughout.
 *
 * The repair is deliberately narrow: only a `modelId` that is exactly a provider kind name, which
 * is never a real model id on any provider. Anything else an admin has set is left alone, because
 * "the environment quietly overrides what you configured" is a worse failure than this one.
 */
async function ensureModelConfigs(providerId: string, modelId: string): Promise<void> {
  const kindNames = new Set(Object.keys(AI_PROVIDER_PROFILES));

  for (const job of JOBS_TO_FILL) {
    const claimed = await prisma.aiModelConfig.findUnique({ where: { job } });
    if (!claimed) {
      await prisma.aiModelConfig.create({ data: { job, providerId, modelId } });
      continue;
    }
    if (kindNames.has(claimed.modelId.trim().toUpperCase())) {
      await prisma.aiModelConfig.update({ where: { job }, data: { modelId } });
      console.warn(
        `[bootstrap] repaired ${job}: "${claimed.modelId}" is a provider kind, not a model id — set to "${modelId}"`,
      );
    }
  }
}
