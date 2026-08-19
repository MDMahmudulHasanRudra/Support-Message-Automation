"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@support-automation/db";
import type { AiProviderKind } from "@prisma/client";
import { requireSession } from "@/server/auth";
import { decryptSecret, encryptSecret } from "@/server/aiCrypto";
import { logSystemEvent } from "@/server/logSystemEvent";

export interface AiProviderFormState {
  error?: string;
}

// GOOGLE/CUSTOM are reserved AiProviderKind values with no client implementation yet
// (see packages/ai-client's resolveAiClient()) — deliberately excluded here so the UI/validator
// only ever expose connection methods that actually work, per the "don't invent it" instruction.
const PROVIDER_KINDS: AiProviderKind[] = ["ANTHROPIC", "OPENAI"];

function isProviderKind(value: string): value is AiProviderKind {
  return (PROVIDER_KINDS as string[]).includes(value);
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
  if (!apiKey) return { error: "API key is required." };

  const provider = await prisma.aiProvider.create({
    data: { name, kind: kindRaw, apiUrl: apiUrl || null, apiKeyCiphertext: encryptSecret(apiKey) },
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
 * Cheapest real connectivity check available per provider — for Anthropic, models.list(); for an
 * OpenAI-compatible endpoint, GET /models. Neither consumes any completion tokens. Only these two
 * kinds have a client implementation (see packages/ai-client's resolveAiClient()) — GOOGLE/CUSTOM
 * are stored but not yet testable.
 */
export async function testAiProviderConnection(id: string): Promise<TestConnectionResult> {
  await requireSession();
  const provider = await prisma.aiProvider.findUnique({ where: { id } });
  if (!provider) return { ok: false, error: "Provider not found." };

  if (provider.kind !== "ANTHROPIC" && provider.kind !== "OPENAI") {
    return { ok: false, error: `Connection testing isn't implemented yet for ${provider.kind}.` };
  }

  try {
    const apiKey = decryptSecret(provider.apiKeyCiphertext);
    if (provider.kind === "ANTHROPIC") {
      const client = new Anthropic({ apiKey, baseURL: provider.apiUrl || undefined });
      await client.models.list({ limit: 1 });
    } else {
      const baseURL = (provider.apiUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
      const response = await fetch(`${baseURL}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
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
