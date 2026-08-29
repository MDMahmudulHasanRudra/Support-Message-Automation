"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@support-automation/db";
import type { AiProviderKind } from "@prisma/client";
import {
  SELECTABLE_AI_PROVIDER_KINDS,
  aiProviderProfile,
  providerRequiresApiKey,
} from "@support-automation/shared";
import { requireSession } from "@/server/auth";
import { decryptSecret, encryptSecret } from "@/server/aiCrypto";
import { logSystemEvent } from "@/server/logSystemEvent";

export interface AiProviderFormState {
  error?: string;
}

// Derived from the shared catalog rather than listed again here, so the validator can never
// accept a kind the form doesn't offer, or reject one it does. GOOGLE/CUSTOM are reserved enum
// values with no client implementation and are excluded by the catalog's `implemented` flag.
const PROVIDER_KINDS = SELECTABLE_AI_PROVIDER_KINDS as AiProviderKind[];

function isProviderKind(value: string): value is AiProviderKind {
  return (PROVIDER_KINDS as string[]).includes(value);
}

/**
 * A typo here is otherwise invisible until the first real completion fails with an opaque
 * fetch error, so it is worth catching at save time.
 */
function validateApiUrl(apiUrl: string): string | null {
  if (!apiUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    return "API URL must be a full URL, for example https://openrouter.ai/api/v1";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "API URL must start with http:// or https://";
  }
  return null;
}

export async function createAiProvider(
  _prevState: AiProviderFormState,
  formData: FormData,
): Promise<AiProviderFormState> {
  await requireSession();

  const name = String(formData.get("name") ?? "").trim();
  const kindRaw = String(formData.get("kind") ?? "");
  const apiUrl = String(formData.get("apiUrl") ?? "").trim();
  const apiKey = String(formData.get("apiKey") ?? "").trim();

  if (!name) return { error: "Name is required." };
  if (!isProviderKind(kindRaw)) return { error: "Invalid provider type." };
  // A self-hosted runtime genuinely has no key; every hosted provider still needs one.
  if (providerRequiresApiKey(kindRaw) && !apiKey) {
    return { error: `${aiProviderProfile(kindRaw)?.label ?? kindRaw} needs an API key.` };
  }
  const urlError = validateApiUrl(apiUrl);
  if (urlError) return { error: urlError };

  const provider = await prisma.aiProvider.create({
    data: {
      name,
      kind: kindRaw,
      apiUrl: apiUrl || null,
      apiKeyCiphertext: apiKey ? encryptSecret(apiKey) : null,
    },
  });

  await logSystemEvent("INFO", "ai-learning", `AI provider "${name}" (${kindRaw}) added`, { providerId: provider.id });
  revalidatePath("/ai-learning/providers");
  redirect("/ai-learning/providers");
}

export async function updateAiProvider(
  id: string,
  _prevState: AiProviderFormState,
  formData: FormData,
): Promise<AiProviderFormState> {
  await requireSession();

  const provider = await prisma.aiProvider.findUnique({ where: { id } });
  if (!provider) return { error: "Provider not found." };

  const name = String(formData.get("name") ?? "").trim();
  const kindRaw = String(formData.get("kind") ?? "");
  const apiUrl = String(formData.get("apiUrl") ?? "").trim();
  const apiKey = String(formData.get("apiKey") ?? "").trim();

  if (!name) return { error: "Name is required." };
  if (!isProviderKind(kindRaw)) return { error: "Invalid provider type." };
  const urlError = validateApiUrl(apiUrl);
  if (urlError) return { error: urlError };
  // Switching an existing keyless provider to a hosted kind has to bring a key with it.
  if (providerRequiresApiKey(kindRaw) && !apiKey && !provider.apiKeyCiphertext) {
    return { error: `${aiProviderProfile(kindRaw)?.label ?? kindRaw} needs an API key.` };
  }

  await prisma.aiProvider.update({
    where: { id },
    data: {
      name,
      kind: kindRaw,
      apiUrl: apiUrl || null,
      // A blank field means "keep the existing key" — never force a re-paste just to rename a provider.
      ...(apiKey ? { apiKeyCiphertext: encryptSecret(apiKey) } : {}),
    },
  });

  await logSystemEvent("INFO", "ai-learning", `AI provider "${name}" updated`, { providerId: id });
  revalidatePath("/ai-learning/providers");
  redirect("/ai-learning/providers");
}

export async function toggleAiProviderStatus(id: string): Promise<void> {
  await requireSession();
  const provider = await prisma.aiProvider.findUnique({ where: { id } });
  if (!provider) return;
  await prisma.aiProvider.update({
    where: { id },
    data: { status: provider.status === "ACTIVE" ? "INACTIVE" : "ACTIVE" },
  });
  revalidatePath("/ai-learning/providers");
}

export async function deleteAiProvider(id: string): Promise<void> {
  await requireSession();
  const provider = await prisma.aiProvider.findUnique({ where: { id } });
  if (!provider) return;
  await prisma.aiProvider.delete({ where: { id } });
  await logSystemEvent("INFO", "ai-learning", `AI provider "${provider.name}" deleted`, { providerId: id });
  revalidatePath("/ai-learning/providers");
}

export interface TestConnectionResult {
  ok: boolean;
  error?: string;
}

async function recordProviderTestResult(id: string, name: string, ok: boolean, error?: string): Promise<void> {
  await prisma.aiProvider.update({
    where: { id },
    data: { lastTestedAt: new Date(), lastTestOk: ok, lastTestError: error ?? null },
  });
  if (ok) {
    await logSystemEvent("INFO", "ai-learning", `Connection test succeeded for "${name}"`, { providerId: id });
  } else {
    await logSystemEvent("WARN", "ai-learning", `Connection test failed for "${name}"`, { providerId: id, error });
  }
  revalidatePath("/ai-learning/providers");
}

/**
 * Cheapest real connectivity check available per provider — for Anthropic, models.list(); for any
 * OpenAI-compatible endpoint (OpenAI, OpenRouter, a local Ollama), GET /models. Neither consumes
 * completion tokens, so testing is free. Kinds without a client implementation
 * (see packages/ai-client's resolveAiClient()) are stored but reported as untestable.
 */
export async function testAiProviderConnection(id: string): Promise<TestConnectionResult> {
  await requireSession();
  const provider = await prisma.aiProvider.findUnique({ where: { id } });
  if (!provider) return { ok: false, error: "Provider not found." };

  const profile = aiProviderProfile(provider.kind);
  if (!profile?.implemented) {
    return { ok: false, error: `Connection testing isn't available for ${provider.kind} yet.` };
  }

  try {
    // Null only for a keyless local runtime; every hosted kind is required to have one at
    // save time, so this cannot be silently missing for a provider that needs it.
    const apiKey = provider.apiKeyCiphertext ? decryptSecret(provider.apiKeyCiphertext) : null;
    if (profile.requiresApiKey && !apiKey) {
      throw new Error("This provider has no API key saved. Edit it and add one.");
    }

    if (provider.kind === "ANTHROPIC") {
      const client = new Anthropic({ apiKey: apiKey!, baseURL: provider.apiUrl || undefined });
      await client.models.list({ limit: 1 });
    } else {
      const baseURL = (provider.apiUrl || profile.defaultApiUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
      const response = await fetch(`${baseURL}/models`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        // A local runtime that is not running should fail fast, not hang the dashboard.
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Request failed with status ${response.status}`);
    }
    await recordProviderTestResult(id, provider.name, true);
    return { ok: true };
  } catch (err) {
    const message = (err as Error).message;
    await recordProviderTestResult(id, provider.name, false, message);
    return { ok: false, error: message };
  }
}
