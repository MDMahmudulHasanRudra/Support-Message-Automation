import { describeAiHttpFailure, describeAiNetworkFailure, type AiFailureDescription } from "@support-automation/shared";
import type { AiClient } from "./AiClient.js";
import type { AiCallOutcomeReporter, AiCompletionRequest, AiCompletionResult } from "./types.js";
import {
  AiProviderCallError,
  RETRY_EXTRA_BUDGET_MS,
  backoffMs,
  isRetriableStatus,
  parseRetryAfterMs,
  shouldRetry,
  sleep,
} from "./retry.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
/** Bounds how long any single AI fallback call can block a message's pipeline pass — mirrors
 * AnthropicClient's own timeout. */
const REQUEST_TIMEOUT_MS = 30_000;
/** A local model on modest hardware is genuinely slower than a hosted one; 30s is not enough. */
const LOCAL_REQUEST_TIMEOUT_MS = 120_000;

interface OpenAiChoiceMessage {
  content?: unknown;
  /**
   * Reasoning models routed through OpenRouter (DeepSeek-R1, the o-series routes, ":thinking"
   * variants) routinely answer with content "" or null and the actual text here. Reading content
   * alone made those look like an empty reply, which the fallback layer then recorded as a
   * malformed response from a model that had in fact answered.
   */
  reasoning?: unknown;
  reasoning_content?: unknown;
}

interface OpenAiChatCompletionResponse {
  choices?: Array<{ message?: OpenAiChoiceMessage; finish_reason?: string | null }>;
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
  /** Invoked once per completed call so provider health reflects real traffic, not just tests. */
  onOutcome?: AiCallOutcomeReporter;
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
  private readonly onOutcome?: AiCallOutcomeReporter;

  constructor(
    private readonly providerId: string,
    private readonly modelId: string,
    options: OpenAiCompatibleOptions,
  ) {
    this.apiKey = options.apiKey;
    this.baseURL = options.baseURL;
    this.extraHeaders = options.extraHeaders ?? {};
    this.timeoutMs = options.slowRuntime ? LOCAL_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
    this.onOutcome = options.onOutcome;
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    const base = (this.baseURL || DEFAULT_BASE_URL).replace(/\/+$/, "");
    const endpoint = `${base}/chat/completions`;
    const body = JSON.stringify({
      model: this.modelId,
      messages: [
        ...(request.systemPrompt ? [{ role: "system", content: request.systemPrompt }] : []),
        { role: "user", content: request.userPrompt },
      ],
      max_tokens: request.maxTokens ?? 1024,
      temperature: request.temperature,
    });

    // Bounds the whole call, retries included, so a retry can never turn a 30s ceiling into 90s.
    const deadline = Date.now() + this.timeoutMs + RETRY_EXTRA_BUDGET_MS;

    for (let attempt = 1; ; attempt++) {
      try {
        const result = await this.attempt(endpoint, body, deadline);
        this.report({ ok: true });
        return result;
      } catch (err) {
        const { description, isTimeout, status, retryAfterMs } = interpret(err, endpoint);
        const waitMs = retryAfterMs ?? backoffMs(attempt);
        const canRetry =
          shouldRetry(description, isTimeout, attempt) && Date.now() + waitMs < deadline;

        if (!canRetry) {
          const attemptNote = attempt > 1 ? ` (after ${attempt} attempts)` : "";
          const message = `${description.message}${attemptNote}`;
          this.report({ ok: false, message, transient: description.transient });
          throw new AiProviderCallError(message, { transient: description.transient, status });
        }
        await sleep(waitMs);
      }
    }
  }

  private async attempt(endpoint: string, body: string, deadline: number): Promise<AiCompletionResult> {
    // Never let one attempt outlive the overall budget, however it was reached.
    const attemptTimeoutMs = Math.max(1_000, Math.min(this.timeoutMs, deadline - Date.now()));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Omitted entirely when there is no key. A local Ollama rejects nothing, but sending
          // `Bearer null` would be a lie about what this request carries.
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          ...this.extraHeaders,
        },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // Never include request headers/body here — only the response status/body, so the API key
      // (sent solely via the Authorization header above) can never end up in a thrown message.
      const errorBody = await response.text().catch(() => "");
      const description = describeAiHttpFailure(response.status, errorBody);
      throw new AiProviderCallError(description.message, {
        transient: description.transient || isRetriableStatus(response.status),
        status: response.status,
        retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
      });
    }

    const raw = await response.text();
    let data: OpenAiChatCompletionResponse;
    try {
      data = JSON.parse(raw) as OpenAiChatCompletionResponse;
    } catch {
      // A proxy or Cloudflare error page is HTML. Parsing it threw a raw SyntaxError that ended up
      // verbatim in AiFallbackDecision.reason, which told an operator nothing about the cause.
      //
      // Deliberately NOT transient. A body that isn't JSON means we are talking to something that
      // is not the model API at all — nearly always a wrong base URL or an intercepting proxy —
      // and no number of retries turns that into a completion. Retrying would only spend the
      // customer's latency budget before delivering the same answer, and appending "(after 3
      // attempts)" to a configuration error reads like a provider outage rather than a setting to
      // go and fix.
      throw new AiProviderCallError(
        "The provider answered with something that was not JSON — usually a proxy or gateway error page rather than the model. Check the API URL.",
        { transient: false, status: response.status },
      );
    }

    // OpenRouter and some proxies report upstream failures in a 200 body rather than an HTTP
    // status. Without this check that surfaces as an empty reply, which the fallback layer would
    // read as "the model declined" instead of "the call failed".
    if (data.error?.message) {
      throw new AiProviderCallError(`The provider returned an error: ${data.error.message.slice(0, 300)}`, {
        transient: true,
      });
    }

    const choice = data.choices?.[0];
    const finishReason = choice?.finish_reason ?? null;
    const text =
      firstNonEmpty(choice?.message?.content) ||
      firstNonEmpty(choice?.message?.reasoning) ||
      firstNonEmpty(choice?.message?.reasoning_content);
    const tokensUsed = (data.usage?.prompt_tokens ?? 0) + (data.usage?.completion_tokens ?? 0);

    // Empty text plus a length stop is unambiguous: the whole budget went to tokens we never saw
    // (a reasoning model's hidden thinking, typically). Reporting that as an empty reply would
    // blame the model for our own ceiling.
    if (!text && finishReason === "length") {
      throw new AiProviderCallError(
        "The model hit its output token limit before producing any answer. Raise the token limit or pick a model that does not spend its whole budget on reasoning.",
        { transient: false },
      );
    }

    return {
      text,
      tokensUsed,
      providerId: this.providerId,
      modelId: this.modelId,
      finishReason,
      truncated: finishReason === "length",
    };
  }

  private report(outcome: Parameters<AiCallOutcomeReporter>[0]): void {
    // Health bookkeeping must never change the outcome of the call it is describing.
    try {
      this.onOutcome?.(outcome);
    } catch {
      /* ignore */
    }
  }
}

/**
 * `content` is a string on every mainstream provider, but the spec permits an array of parts and
 * some upstreams (and OpenRouter routes to them) use it. Letting a non-string through meant a
 * downstream `text.match(...)` threw a TypeError nowhere near the cause.
 */
function firstNonEmpty(value: unknown): string {
  if (typeof value === "string") return value.trim() ? value : "";
  if (Array.isArray(value)) {
    const joined = value
      .map((part) => {
        if (typeof part === "string") return part;
        const text = (part as { text?: unknown } | null)?.text;
        return typeof text === "string" ? text : "";
      })
      .join("");
    return joined.trim() ? joined : "";
  }
  return "";
}

function interpret(
  err: unknown,
  endpoint: string,
): { description: AiFailureDescription; isTimeout: boolean; status?: number; retryAfterMs: number | null } {
  if (err instanceof AiProviderCallError) {
    return {
      description: { message: err.message, transient: err.transient },
      isTimeout: false,
      status: err.status,
      retryAfterMs: err.retryAfterMs ?? null,
    };
  }
  const isTimeout = (err as Error | null)?.name === "AbortError";
  return { description: describeAiNetworkFailure(err, endpoint), isTimeout, retryAfterMs: null };
}
