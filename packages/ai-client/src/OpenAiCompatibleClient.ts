import type { AiClient } from "./AiClient.js";
import type { AiCompletionRequest, AiCompletionResult } from "./types.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
/** Bounds how long any single AI fallback call can block a message's pipeline pass — mirrors
 * AnthropicClient's own timeout. */
const REQUEST_TIMEOUT_MS = 30_000;

interface OpenAiChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Covers any endpoint speaking the standard OpenAI chat-completions REST shape — the real OpenAI
 * API (default `baseURL`, mirroring AnthropicClient's own "blank = provider's real default
 * endpoint" behavior), a self-hosted/local model runtime, or a custom internal proxy, since all of
 * these commonly expose this exact same protocol. Uses bare `fetch` (Node >=22.13, this repo's
 * minimum) rather than a new SDK dependency, for one HTTP POST — see
 * apps/worker/src/notifications/TeamsProvider.ts for this codebase's existing precedent of a raw
 * fetch() call. resolveAiClient() is the only place that constructs this.
 */
export class OpenAiCompatibleClient implements AiClient {
  constructor(
    private readonly providerId: string,
    private readonly modelId: string,
    private readonly apiKey: string,
    private readonly baseURL?: string | null,
  ) {}

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    const base = (this.baseURL || DEFAULT_BASE_URL).replace(/\/+$/, "");
    const messages = [
      ...(request.systemPrompt ? [{ role: "system", content: request.systemPrompt }] : []),
      { role: "user", content: request.userPrompt },
    ];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.modelId,
          messages,
          max_tokens: request.maxTokens ?? 1024,
          temperature: request.temperature,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new Error(`OpenAI-compatible request timed out after ${REQUEST_TIMEOUT_MS}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      // Never include request headers/body here — only the response status/body, so the API key
      // (sent solely via the Authorization header above) can never end up in a thrown message.
      throw new Error(`OpenAI-compatible request failed (${response.status}): ${errorBody.slice(0, 500)}`);
    }

    const data = (await response.json()) as OpenAiChatCompletionResponse;
    const text = data.choices?.[0]?.message?.content ?? "";
    const tokensUsed = (data.usage?.prompt_tokens ?? 0) + (data.usage?.completion_tokens ?? 0);

    return { text, tokensUsed, providerId: this.providerId, modelId: this.modelId };
  }
}
