import Anthropic from "@anthropic-ai/sdk";
import type { AiClient } from "./AiClient.js";
import type { AiCompletionRequest, AiCompletionResult } from "./types.js";

/**
 * Wraps @anthropic-ai/sdk — the only AiProviderKind implemented so far, matching
 * testAiProviderConnection()'s existing precedent (apps/web/src/server/actions/aiProviders.ts)
 * that only ANTHROPIC is wired up today. resolveAiClient() is the only place that constructs this.
 */
export class AnthropicClient implements AiClient {
  private readonly client: Anthropic;

  constructor(
    private readonly providerId: string,
    private readonly modelId: string,
    apiKey: string,
    baseURL?: string | null,
  ) {
    this.client = new Anthropic({ apiKey, baseURL: baseURL || undefined });
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
