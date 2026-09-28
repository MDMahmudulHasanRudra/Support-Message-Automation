"use server";

import { projectPath } from "@/server/projectPaths";
import { prisma } from "@/server/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import Anthropic from "@anthropic-ai/sdk";

import type { AiProviderKind } from "@prisma/client";
import {
  SELECTABLE_AI_PROVIDER_KINDS,
  aiProviderProfile,
  describeAiHttpFailure,
  describeAiNetworkFailure,
  openRouterAttributionHeaders,
  providerRequiresApiKey,
  type AiModelListEntry,
  type AiProviderProfile,
} from "@support-automation/shared";
import { checkPermission, requireAccess } from "@/server/authorize";
import { decryptSecret, encryptSecret } from "@/server/aiCrypto";
import { logSystemEvent } from "@/server/logSystemEvent";

export interface AiProviderFormState {
  error?: string;
}

// Derived from the shared catalog rather than listed again here, so the validator can never
// accept a kind the form doesn't offer, or reject one it does. GOOGLE/CUSTOM are reserved enum
// values with no client implementation and are excluded by the catalog's `implemented` flag.
const PROVIDER_KINDS = SELECTABLE_AI_PROVIDER_KINDS as AiProviderKind[];

/** A dashboard action must not hang on an unreachable host; every outbound call here is bounded. */
const PROBE_TIMEOUT_MS = 15_000;

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
  const granted = await checkPermission("ai_settings.edit");
  if ("denied" in granted) return { error: granted.denied };

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
      // A keyless kind must never carry one, even if a key somehow arrives in the payload.
      apiKeyCiphertext: providerRequiresApiKey(kindRaw) && apiKey ? encryptSecret(apiKey) : null,
    },
  });

  await logSystemEvent("INFO", "ai-learning", `AI provider "${name}" (${kindRaw}) added`, { providerId: provider.id });
  revalidatePath(await projectPath("/ai-learning/providers"));
  redirect(await projectPath("/ai-learning/providers"));
}

export async function updateAiProvider(
  id: string,
  _prevState: AiProviderFormState,
  formData: FormData,
): Promise<AiProviderFormState> {
  const granted = await checkPermission("ai_settings.edit");
  if ("denied" in granted) return { error: granted.denied };

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

  const kindChanged = provider.kind !== kindRaw;
  const newKindNeedsKey = providerRequiresApiKey(kindRaw);

  // A stored key belongs to the provider it was issued for. Carrying it across a type change once
  // meant switching OpenAI → Ollama kept a live hosted key on the row and then sent it, as
  // `Authorization: Bearer <real key>`, to whatever plain-http host the Ollama URL pointed at.
  // Changing the type therefore always discards the old key: either a new one is supplied, or the
  // column is nulled.
  if (kindChanged && newKindNeedsKey && !apiKey) {
    const from = aiProviderProfile(provider.kind)?.label ?? provider.kind;
    const to = aiProviderProfile(kindRaw)?.label ?? kindRaw;
    return {
      error: `Changing this provider from ${from} to ${to} discards the saved key, because it was issued by ${from}. Paste a ${to} API key to continue.`,
    };
  }
  // Switching an existing keyless provider to a hosted kind has to bring a key with it.
  if (newKindNeedsKey && !apiKey && !provider.apiKeyCiphertext) {
    return { error: `${aiProviderProfile(kindRaw)?.label ?? kindRaw} needs an API key.` };
  }

  const nextCiphertext = apiKey && newKindNeedsKey ? encryptSecret(apiKey) : null;
  // Any change to what the request will actually be makes the stored verdict stale — it described
  // a different key, endpoint or vendor.
  const connectionChanged = kindChanged || Boolean(apiKey) || (apiUrl || null) !== provider.apiUrl;

  await prisma.aiProvider.update({
    where: { id },
    data: {
      name,
      kind: kindRaw,
      apiUrl: apiUrl || null,
      // A blank field means "keep the existing key" — never force a re-paste just to rename a
      // provider — but only while the type (and so the key's issuer) is unchanged.
      ...(nextCiphertext || kindChanged || !newKindNeedsKey ? { apiKeyCiphertext: nextCiphertext } : {}),
      ...(connectionChanged ? { lastTestedAt: null, lastTestOk: null, lastTestError: null } : {}),
    },
  });

  await logSystemEvent("INFO", "ai-learning", `AI provider "${name}" updated`, { providerId: id });
  revalidatePath(await projectPath("/ai-learning/providers"));
  redirect(await projectPath("/ai-learning/providers"));
}

export async function toggleAiProviderStatus(id: string): Promise<void> {
  await requireAccess("ai_settings.edit");
  const provider = await prisma.aiProvider.findUnique({ where: { id } });
  if (!provider) return;
  await prisma.aiProvider.update({
    where: { id },
    data: { status: provider.status === "ACTIVE" ? "INACTIVE" : "ACTIVE" },
  });
  revalidatePath(await projectPath("/ai-learning/providers"));
}

export async function deleteAiProvider(id: string): Promise<void> {
  await requireAccess("ai_settings.edit");
  const provider = await prisma.aiProvider.findUnique({ where: { id } });
  if (!provider) return;
  await prisma.aiProvider.delete({ where: { id } });
  await logSystemEvent("INFO", "ai-learning", `AI provider "${provider.name}" deleted`, { providerId: id });
  revalidatePath(await projectPath("/ai-learning/providers"));
}

export interface TestConnectionResult {
  ok: boolean;
  /** Actionable prose on failure. */
  error?: string;
  /** What was actually verified, on success — the point of the button is knowing that. */
  message?: string;
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
  revalidatePath(await projectPath("/ai-learning/providers"));
}

/**
 * Proves the configured credentials can actually produce an answer.
 *
 * The old version asked for GET {base}/models and asserted `response.ok`, which was worthless for
 * exactly the two kinds people most need to verify: OpenRouter's model catalogue is public and
 * answers 200 to a garbage key, and Ollama has no auth at all. A green badge meant "the host is
 * reachable" while claiming to mean "this will work."
 *
 * So the test now does what the real path does: authenticate, then send a genuine two-token
 * completion to the model this provider is actually assigned, with the same endpoint, the same
 * headers (OpenRouter's attribution pair included) and the same failure classifier
 * (`describeAiHttpFailure`) that packages/ai-client uses — apps/web cannot import that package, so
 * the request shape is mirrored here and the classification is shared rather than duplicated. Two
 * tokens costs a fraction of a cent and is the only thing that genuinely proves a completion works.
 */
export async function testAiProviderConnection(id: string): Promise<TestConnectionResult> {
  const granted = await checkPermission("ai_settings.edit");
  if ("denied" in granted) return { ok: false, error: granted.denied };
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

    const credentialNote = await verifyCredentials(provider.kind, provider.apiUrl, profile, apiKey);
    const modelId = await assignedModelId(id);

    if (!modelId) {
      await recordProviderTestResult(id, provider.name, true);
      return {
        ok: true,
        message: `${credentialNote} No model is assigned to this provider yet, so no completion was tried — assign one on the AI Models page and test again.`,
      };
    }

    await probeCompletion(provider.kind, provider.apiUrl, profile, apiKey, modelId);
    await recordProviderTestResult(id, provider.name, true);
    return { ok: true, message: `${credentialNote} A real completion using "${modelId}" succeeded.` };
  } catch (err) {
    const message = (err as Error).message;
    await recordProviderTestResult(id, provider.name, false, message);
    return { ok: false, error: message };
  }
}

/** Prefers the job most likely to be exercised in production, so the test matches real traffic. */
async function assignedModelId(providerId: string): Promise<string | null> {
  const configs = await prisma.aiModelConfig.findMany({ where: { providerId } });
  if (configs.length === 0) return null;
  const preferred = ["RESPONSE", "LEARNING", "ADMIN_ASSISTANT"];
  for (const job of preferred) {
    const match = configs.find((c) => c.job === job);
    if (match) return match.modelId;
  }
  return configs[0]!.modelId;
}

/**
 * Confirms the key itself is accepted, before any model is involved — so "your key is wrong" and
 * "that model id doesn't exist" never get reported as the same failure.
 */
async function verifyCredentials(
  kind: string,
  apiUrl: string | null,
  profile: AiProviderProfile,
  apiKey: string | null,
): Promise<string> {
  if (kind === "ANTHROPIC") {
    const client = new Anthropic({
      apiKey: apiKey!,
      baseURL: apiUrl || undefined,
      timeout: PROBE_TIMEOUT_MS,
      maxRetries: 0,
    });
    await client.models.list({ limit: 1 }).catch((err: unknown) => {
      throw new Error(describeAnthropicError(err).message);
    });
    return "The API key was accepted.";
  }

  const base = resolveBaseUrl(apiUrl, profile);

  if (kind === "OPENROUTER") {
    // OpenRouter's /models is a public catalogue and says nothing about the key; /key is the
    // authenticated endpoint, and it also reports whether the account has credit left.
    const data = await getJson(`${base}/key`, authHeaders(apiKey, kind));
    const info = (data as { data?: { limit_remaining?: number | null; usage?: number } }).data;
    if (info && typeof info.limit_remaining === "number" && info.limit_remaining <= 0) {
      throw new Error("The API key is valid but the OpenRouter account has no credit left. Top it up, then test again.");
    }
    return "The API key was accepted by OpenRouter.";
  }

  if (kind === "OLLAMA") {
    // Nothing to authenticate — reachability is the whole question for a self-hosted runtime.
    await getJson(`${base}/models`, {});
    return "The Ollama endpoint is reachable.";
  }

  await getJson(`${base}/models`, authHeaders(apiKey, kind));
  return "The API key was accepted.";
}

/** A genuine, minimal completion — the only check that proves the whole path end to end. */
async function probeCompletion(
  kind: string,
  apiUrl: string | null,
  profile: AiProviderProfile,
  apiKey: string | null,
  modelId: string,
): Promise<void> {
  if (kind === "ANTHROPIC") {
    const client = new Anthropic({
      apiKey: apiKey!,
      baseURL: apiUrl || undefined,
      timeout: PROBE_TIMEOUT_MS,
      maxRetries: 0,
    });
    await client.messages
      .create({ model: modelId, max_tokens: 2, messages: [{ role: "user", content: "ping" }] })
      .catch((err: unknown) => {
        throw new Error(describeAnthropicError(err).message);
      });
    return;
  }

  const base = resolveBaseUrl(apiUrl, profile);
  const endpoint = `${base}/chat/completions`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(apiKey, kind) },
      // Two tokens: enough to prove generation started, small enough to be free in practice. The
      // answer is expected to be cut off — only an error matters here.
      body: JSON.stringify({ model: modelId, messages: [{ role: "user", content: "ping" }], max_tokens: 2 }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(describeAiNetworkFailure(err, endpoint).message);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(describeAiHttpFailure(response.status, body).message);
  }

  const raw = await response.text();
  let parsed: { error?: { message?: string } };
  try {
    parsed = JSON.parse(raw) as { error?: { message?: string } };
  } catch {
    throw new Error(
      "The endpoint answered with something that was not JSON — usually a proxy or gateway error page rather than the model. Check the API URL.",
    );
  }
  // Some gateways report an upstream failure inside a 200 body.
  if (parsed.error?.message) throw new Error(`The provider returned an error: ${parsed.error.message.slice(0, 300)}`);
}

/**
 * Fetches the provider's real model catalogue for the AI Models picker. Runs here, on the server,
 * because it needs the decrypted key — and returns only ids and display names, never the raw
 * payload and never the key.
 *
 * Failure is never fatal: the picker falls back to a free-text field, because refusing to save a
 * perfectly valid model id just because a listing call failed would be worse than the typo this
 * feature exists to prevent.
 */
export async function listAiProviderModels(
  providerId: string,
): Promise<{ models: AiModelListEntry[]; error?: string }> {
  const granted = await checkPermission("ai_settings.edit");
  if ("denied" in granted) return { models: [], error: granted.denied };

  const provider = await prisma.aiProvider.findUnique({ where: { id: providerId } });
  if (!provider) return { models: [], error: "Provider not found." };

  const profile = aiProviderProfile(provider.kind);
  if (!profile?.implemented) {
    return { models: [], error: `${provider.kind} has no model list — type the model id instead.` };
  }

  try {
    const apiKey = provider.apiKeyCiphertext ? decryptSecret(provider.apiKeyCiphertext) : null;
    if (profile.requiresApiKey && !apiKey) {
      return { models: [], error: "This provider has no API key saved, so its model list can't be fetched." };
    }

    if (provider.kind === "ANTHROPIC") {
      const client = new Anthropic({
        apiKey: apiKey!,
        baseURL: provider.apiUrl || undefined,
        timeout: PROBE_TIMEOUT_MS,
        maxRetries: 0,
      });
      const page = await client.models.list({ limit: 100 }).catch((err: unknown) => {
        throw new Error(describeAnthropicError(err).message);
      });
      const models = page.data.map((m) => ({ id: m.id, label: m.display_name || m.id }));
      return { models: sortModels(models) };
    }

    const base = resolveBaseUrl(provider.apiUrl, profile);
    const data = await getJson(`${base}/models`, authHeaders(apiKey, provider.kind));
    const entries = (data as { data?: unknown }).data;
    if (!Array.isArray(entries)) {
      return { models: [], error: "The provider's model list came back in an unexpected shape." };
    }
    const models = entries
      .map((entry) => {
        const row = entry as { id?: unknown; name?: unknown };
        if (typeof row.id !== "string" || !row.id) return null;
        return { id: row.id, label: typeof row.name === "string" && row.name ? row.name : row.id };
      })
      .filter((m): m is AiModelListEntry => m !== null);
    return { models: sortModels(models) };
  } catch (err) {
    return { models: [], error: (err as Error).message };
  }
}

/** OpenRouter alone lists several hundred; a stable alphabetical order makes the list navigable. */
function sortModels(models: AiModelListEntry[]): AiModelListEntry[] {
  return models.sort((a, b) => a.id.localeCompare(b.id));
}

function resolveBaseUrl(apiUrl: string | null, profile: AiProviderProfile): string {
  return (apiUrl || profile.defaultApiUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
}

function authHeaders(apiKey: string | null, kind: string): Record<string, string> {
  return {
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    // Sent here too so the test exercises the same request shape the live client sends.
    ...(kind === "OPENROUTER" ? openRouterAttributionHeaders() : {}),
  };
}

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  let response: Response;
  try {
    // A local runtime that is not running should fail fast, not hang the dashboard.
    response = await fetch(url, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch (err) {
    throw new Error(describeAiNetworkFailure(err, url).message);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(describeAiHttpFailure(response.status, body).message);
  }
  const raw = await response.text();
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(
      "The endpoint answered with something that was not JSON — check the API URL points at the API, not a web page.",
    );
  }
}

/** Maps an SDK error onto the same vocabulary an OpenAI-compatible failure gets. */
function describeAnthropicError(err: unknown): { message: string } {
  const candidate = err as { status?: number; message?: string } | null;
  if (typeof candidate?.status === "number") {
    return describeAiHttpFailure(candidate.status, JSON.stringify({ error: { message: candidate.message ?? "" } }));
  }
  return describeAiNetworkFailure(err, "https://api.anthropic.com");
}
