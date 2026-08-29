import type { AiClient } from "./AiClient.js";
import type { AiCompletionRequest, AiCompletionResult } from "./types.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
/** Bounds how long any single AI fallback call can block a message's pipeline pass — mirrors
 * AnthropicClient's own timeout. */
const REQUEST_TIMEOUT_MS = 30_000;
/** A local model on modest hardware is genuinely slower than a hosted one; 30s is not enough. */
const LOCAL_REQUEST_TIMEOUT_MS = 120_000;

interface OpenAiChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  /** Some gateways answer 200 with an error envelope instead of an HTTP error status. */
  error?: { message?: string };
}

export interface OpenAiCompatibleOptions {
  /** Null for a keyless local runtime — the Authorization header is then omitted entirely. */
  apiKey: string | null;
  baseURL?: string | null;
  /** Extra headers a specific gateway wants (OpenRouter's attribution pair, for instance). */
  extraHeaders?: Record<string, string>;
  /** Local runtimes get a longer ceiling than hosted APIs. */
  slowRuntime?: boolean;
}

/**
 * Covers any endpoint speaking the standard OpenAI chat-completions REST shape — the real OpenAI
 * API (default `baseURL`, mirroring AnthropicClient's own "blank = provider's real default
 * endpoint" behavior), OpenRouter, a self-hosted Ollama or other local model runtime, or a custom
 * internal proxy, since all of these expose this exact same protocol. Uses bare `fetch` (Node
 * >=22.13, this repo's minimum) rather than a new SDK dependency, for one HTTP POST — see
 * apps/worker/src/notifications/TeamsProvider.ts for this codebase's existing precedent of a raw
 * fetch() call. resolveAiClient() is the only place that constructs this.
 */
export class OpenAiCompatibleClient implements AiClient {
  private readonly apiKey: string | null;
  private readonly baseURL?: string | null;
  private readonly extraHeaders: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(
    private readonly providerId: string,
    private readonly modelId: string,
    options: OpenAiCompatibleOptions,
  ) {
    this.apiKey = options.apiKey;
    this.baseURL = options.baseURL;
    this.extraHeaders = options.extraHeaders ?? {};
    this.timeoutMs = options.slowRuntime ? LOCAL_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    const base = (this.baseURL || DEFAULT_BASE_URL).replace(/\/+$/, "");
    const messages = [
      ...(request.systemPrompt ? [{ role: "system", content: request.systemPrompt }] : []),
      { role: "user", content: request.userPrompt },
    ];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Omitted entirely when there is no key. A local Ollama rejects nothing, but sending
          // `Bearer null` would be a lie about what this request carries.
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          ...this.extraHeaders,
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
        throw new Error(`OpenAI-compatible request timed out after ${this.timeoutMs}ms`);
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
    // OpenRouter and some proxies report upstream failures in a 200 body rather than an HTTP
    // status. Without this check that surfaces as an empty reply, which the fallback layer would
    // read as "the model declined" instead of "the call failed".
    if (data.error?.message) {
      throw new Error(`OpenAI-compatible request failed: ${data.error.message.slice(0, 500)}`);
    }

    const text = data.choices?.[0]?.message?.content ?? "";
    const tokensUsed = (data.usage?.prompt_tokens ?? 0) + (data.usage?.completion_tokens ?? 0);

    return { text, tokensUsed, providerId: this.providerId, modelId: this.modelId };
  }
}
