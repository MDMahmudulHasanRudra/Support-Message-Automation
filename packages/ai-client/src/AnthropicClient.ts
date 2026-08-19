import Anthropic from "@anthropic-ai/sdk";
import type { AiClient } from "./AiClient.js";
import type { AiCompletionRequest, AiCompletionResult } from "./types.js";

/** Bounds how long any single AI fallback call can block a message's pipeline pass — see
 * REQUEST_TIMEOUT_MS's use with maxRetries:0 below for why both are needed together. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Wraps @anthropic-ai/sdk — one of two AiProviderKinds implemented so far (alongside
 * OpenAiCompatibleClient), matching testAiProviderConnection()'s precedent
 * (apps/web/src/server/actions/aiProviders.ts). resolveAiClient() is the only place that
 * constructs this.
 */
export class AnthropicClient implements AiClient {
  private readonly client: Anthropic;

  constructor(
    private readonly providerId: string,
    private readonly modelId: string,
    apiKey: string,
    baseURL?: string | null,
  ) {
    // maxRetries: 0 alongside the timeout — the SDK retries a per-attempt timeout by default
    // (up to 2x), which would let one call block the synchronously-awaited pipeline for up to
    // ~3x REQUEST_TIMEOUT_MS instead of the intended hard ceiling.
    this.client = new Anthropic({ apiKey, baseURL: baseURL || undefined, timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 });
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    const response = await this.client.messages.create({
      model: this.modelId,
      max_tokens: request.maxTokens ?? 1024,
      temperature: request.temperature,
      system: request.systemPrompt,
      messages: [{ role: "user", content: request.userPrompt }],
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    return {
      text,
      tokensUsed: response.usage.input_tokens + response.usage.output_tokens,
      providerId: this.providerId,
      modelId: this.modelId,
    };
  }
}
