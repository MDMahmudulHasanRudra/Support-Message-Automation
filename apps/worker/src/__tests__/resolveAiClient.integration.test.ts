import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma, encryptSecret } from "@support-automation/db";
import { resolveAiClient, AnthropicClient, OpenAiCompatibleClient } from "@support-automation/ai-client";
import type { AiSettings } from "@prisma/client";

/**
 * Confirms resolveAiClient() picks the correct client implementation per AiProviderKind — the
 * "multiple provider configurations resolve correctly" requirement. Requires
 * AI_CREDENTIALS_ENCRYPTION_KEY to be set (same as any real deployment) since AiProvider rows here
 * are genuinely encrypted, not overridden with a mock — this test exercises the real
 * decrypt-and-construct path, unlike aiFallback.integration.test.ts's MockAiClient-based tests.
 */

let originalAiSettings: AiSettings;
const createdProviderIds: string[] = [];

async function makeProvider(kind: "ANTHROPIC" | "OPENAI" | "GOOGLE" | "CUSTOM") {
  const provider = await prisma.aiProvider.create({
    data: { name: `Test ${kind} Provider`, kind, apiKeyCiphertext: encryptSecret("fake-test-key"), status: "ACTIVE" },
  });
  createdProviderIds.push(provider.id);
  return provider;
}

async function assignResponseModel(providerId: string) {
  await prisma.aiModelConfig.upsert({
    where: { job: "RESPONSE" },
    update: { providerId, modelId: "test-model" },
    create: { job: "RESPONSE", providerId, modelId: "test-model" },
  });
}

beforeAll(async () => {
  originalAiSettings = await prisma.aiSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
  await prisma.aiSettings.update({ where: { id: "global" }, data: { aiEngineEnabled: true, learningEnabled: true } });
});

afterAll(async () => {
  await prisma.aiSettings.update({ where: { id: "global" }, data: originalAiSettings });
});

afterEach(async () => {
  await prisma.aiModelConfig.deleteMany({ where: { job: "RESPONSE" } });
  if (createdProviderIds.length) {
    await prisma.aiProvider.deleteMany({ where: { id: { in: createdProviderIds } } });
    createdProviderIds.length = 0;
  }
});

describe("resolveAiClient — provider kind resolution", () => {
  it("resolves an ANTHROPIC provider to AnthropicClient", async () => {
    const provider = await makeProvider("ANTHROPIC");
    await assignResponseModel(provider.id);

    const client = await resolveAiClient("RESPONSE");
    expect(client).toBeInstanceOf(AnthropicClient);
  });

  it("resolves an OPENAI provider to OpenAiCompatibleClient", async () => {
    const provider = await makeProvider("OPENAI");
    await assignResponseModel(provider.id);

    const client = await resolveAiClient("RESPONSE");
    expect(client).toBeInstanceOf(OpenAiCompatibleClient);
  });

  it("resolves an unimplemented kind (GOOGLE) to null, failing closed rather than throwing", async () => {
    const provider = await makeProvider("GOOGLE");
    await assignResponseModel(provider.id);

    const client = await resolveAiClient("RESPONSE");
    expect(client).toBeNull();
  });

  it("resolves an unimplemented kind (CUSTOM) to null", async () => {
    const provider = await makeProvider("CUSTOM");
    await assignResponseModel(provider.id);

    const client = await resolveAiClient("RESPONSE");
    expect(client).toBeNull();
  });

  it("resolves to null when no AiModelConfig exists for the job at all", async () => {
    const client = await resolveAiClient("RESPONSE");
    expect(client).toBeNull();
  });

  it("resolves the RESPONSE job while Conversation Learning is switched off", async () => {
    // Regression guard. resolveAiClient() used to also require AiSettings.learningEnabled — a
    // flag that belongs to Conversation Learning alone. Because it defaults to false, the Hybrid
    // AI Automation fallback (job "RESPONSE") could never obtain a client: every AI-eligible
    // message recorded an AI_UNAVAILABLE human fallback and raised an alert instead of replying,
    // and nothing in the dashboard explained why. Per-job gating belongs to the job.
    const provider = await makeProvider("ANTHROPIC");
    await assignResponseModel(provider.id);
    await prisma.aiSettings.update({ where: { id: "global" }, data: { learningEnabled: false } });

    try {
      const client = await resolveAiClient("RESPONSE");
      expect(client).toBeInstanceOf(AnthropicClient);
    } finally {
      await prisma.aiSettings.update({ where: { id: "global" }, data: { learningEnabled: true } });
    }
  });

  it("still resolves to null for every job when the AI engine master switch is off", async () => {
    const provider = await makeProvider("ANTHROPIC");
    await assignResponseModel(provider.id);
    await prisma.aiSettings.update({ where: { id: "global" }, data: { aiEngineEnabled: false } });

    try {
      expect(await resolveAiClient("RESPONSE")).toBeNull();
      expect(await resolveAiClient("LEARNING")).toBeNull();
    } finally {
      await prisma.aiSettings.update({ where: { id: "global" }, data: { aiEngineEnabled: true } });
    }
  });

  it("never exposes the decrypted API key as an enumerable own property on the resolved client", async () => {
    const provider = await makeProvider("ANTHROPIC");
    await assignResponseModel(provider.id);

    const client = await resolveAiClient("RESPONSE");
    // A shallow own-property check, not a deep JSON.stringify — the underlying Anthropic SDK
    // client object is internally circular (an SDK implementation detail, not a security
    // concern), so a deep serialization isn't the right tool here. The real guarantee —
    // AnthropicClient's own fields are `private readonly`, and the key itself is passed straight
    // into the SDK constructor, never assigned to a field on `this` — is exercised directly by
    // OpenAiCompatibleClient's own unit test (packages/ai-client), which does safely serialize
    // its (non-circular) request/response objects and confirm the key never appears in them.
    for (const value of Object.values(client as unknown as Record<string, unknown>)) {
      if (typeof value === "string") {
        expect(value).not.toContain("fake-test-key");
      }
    }
  });
});
