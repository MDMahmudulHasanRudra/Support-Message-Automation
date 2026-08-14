import type { AiClient, AiCompletionRequest, AiCompletionResult } from "@support-automation/ai-client";

/**
 * A mocked AiClient for tests — apps/worker/src/learning/aiAnalysisJob.ts is exercised for real
 * (gating, candidate selection, response parsing, status transitions) without ever calling a real
 * AI provider or needing a real API key. Mirrors mockProvider.ts's shape/conventions.
 */
export class MockAiClient implements AiClient {
  public requests: AiCompletionRequest[] = [];
  /** Queued responses, consumed in order; falls back to nextText/nextResult for any call beyond the queue. */
  public queuedTexts: string[] = [];
  public nextText = "CONFIDENCE: 85\nSUMMARY: This looks like a genuine, reusable support pattern.";

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    this.requests.push(request);
    const text = this.queuedTexts.length > 0 ? this.queuedTexts.shift()! : this.nextText;
    return { text, tokensUsed: 42, providerId: "mock-provider", modelId: "mock-model" };
  }
}
