import Anthropic from "@anthropic-ai/sdk";
import { describeAiHttpFailure, describeAiNetworkFailure, type AiFailureDescription } from "@support-automation/shared";
import type { AiClient } from "./AiClient.js";
import type { AiCallOutcomeReporter, AiCompletionRequest, AiCompletionResult } from "./types.js";
import { AiProviderCallError, RETRY_EXTRA_BUDGET_MS, backoffMs, shouldRetry, sleep } from "./retry.js";

/** Bounds how long any single AI fallback call can block a message's pipeline pass — see
 * REQUEST_TIMEOUT_MS's use with maxRetries:0 below for why both are needed together. */
const REQUEST_TIMEOUT_MS = 30_000;

export interface AnthropicClientOptions {
  baseURL?: string | null;
  /** Invoked once per completed call so provider health reflects real traffic, not just tests. */
  onOutcome?: AiCallOutcomeReporter;
}

/**
 * Wraps @anthropic-ai/sdk — one of two AiProviderKinds implemented so far (alongside
 * OpenAiCompatibleClient), matching testAiProviderConnection()'s precedent
 * (apps/web/src/server/actions/aiProviders.ts). resolveAiClient() is the only place that
 * constructs this.
 */
export class AnthropicClient implements AiClient {
  private readonly client: Anthropic;
  private readonly onOutcome?: AiCallOutcomeReporter;

  constructor(
    private readonly providerId: string,
    private readonly modelId: string,
    apiKey: string,
    baseURLOrOptions?: string | null | AnthropicClientOptions,
  ) {
    // Third positional argument kept as a plain baseURL for the existing call sites; an options
    // object is the way any new setting arrives.
    const options: AnthropicClientOptions =
      typeof baseURLOrOptions === "string" || baseURLOrOptions == null
        ? { baseURL: baseURLOrOptions ?? null }
        : baseURLOrOptions;
    this.onOutcome = options.onOutcome;
    // maxRetries: 0 alongside the timeout — the SDK retries a per-attempt timeout by default
    // (up to 2x), which would let one call block the synchronously-awaited pipeline for up to
    // ~3x REQUEST_TIMEOUT_MS instead of the intended hard ceiling. Retrying a genuinely transient
    // HTTP failure is still worth doing, so this class does it itself below, under one shared
    // deadline and never for a timeout.
    this.client = new Anthropic({
      apiKey,
      baseURL: options.baseURL || undefined,
      timeout: REQUEST_TIMEOUT_MS,
      maxRetries: 0,
    });
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    const deadline = Date.now() + REQUEST_TIMEOUT_MS + RETRY_EXTRA_BUDGET_MS;

    for (let attempt = 1; ; attempt++) {
      try {
        const result = await this.attempt(request, deadline);
        this.report({ ok: true });
        return result;
      } catch (err) {
        const { description, isTimeout, status } = interpret(err);
        const waitMs = backoffMs(attempt);
        const canRetry = shouldRetry(description, isTimeout, attempt) && Date.now() + waitMs < deadline;

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

  private async attempt(request: AiCompletionRequest, deadline: number): Promise<AiCompletionResult> {
    const response = await this.client.messages.create(
      {
        model: this.modelId,
        max_tokens: request.maxTokens ?? 1024,
        temperature: request.temperature,
        system: request.systemPrompt,
        messages: [{ role: "user", content: request.userPrompt }],
      },
      // Never let one attempt outlive the overall budget, however it was reached.
      { timeout: Math.max(1_000, Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now())) },
    );

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    return {
      text,
      tokensUsed: response.usage.input_tokens + response.usage.output_tokens,
      providerId: this.providerId,
      modelId: this.modelId,
      finishReason: response.stop_reason ?? null,
      truncated: response.stop_reason === "max_tokens",
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

function interpret(err: unknown): { description: AiFailureDescription; isTimeout: boolean; status?: number } {
  if (err instanceof AiProviderCallError) {
    return { description: { message: err.message, transient: err.transient }, isTimeout: false, status: err.status };
  }

  const candidate = err as { status?: number; name?: string; message?: string } | null;
  const message = candidate?.message ?? "";
  const isTimeout = /timeout/i.test(candidate?.name ?? "") || /timed out/i.test(message);

  if (typeof candidate?.status === "number") {
    // Re-wrap the SDK's own text as the JSON envelope the shared classifier reads, so an Anthropic
    // failure reads the same way an OpenAI-compatible one does.
    const body = JSON.stringify({ error: { message } });
    return { description: describeAiHttpFailure(candidate.status, body), isTimeout, status: candidate.status };
  }

  return { description: describeAiNetworkFailure(err), isTimeout };
}
