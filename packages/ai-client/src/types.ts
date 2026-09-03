export interface AiCompletionRequest {
  systemPrompt?: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
}

export interface AiCompletionResult {
  text: string;
  tokensUsed: number;
  providerId: string;
  modelId: string;
  /**
   * Why the provider stopped generating, verbatim from it ("stop", "length", "max_tokens", …).
   * Optional and additive: existing callers ignore it, but without it a reply cut off by the token
   * ceiling is indistinguishable from a malformed one, and the AI Activity log blamed the model
   * for a MALFORMED_RESPONSE that was really our own maxTokens being too small.
   */
  finishReason?: string | null;
  /** Convenience read of `finishReason`: the answer was cut off, not finished. */
  truncated?: boolean;
}

/**
 * What a completed (or failed) live call reports back about the provider's health. Passed as a
 * hook rather than written from inside the clients so this package's client classes stay free of
 * Prisma — resolveAiClient() supplies the implementation that persists it.
 */
export type AiCallOutcome = { ok: true } | { ok: false; message: string; transient: boolean };

export type AiCallOutcomeReporter = (outcome: AiCallOutcome) => void;
