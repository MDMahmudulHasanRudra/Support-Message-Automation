import type { AiCompletionRequest, AiCompletionResult } from "./types.js";

/**
 * The one abstraction every AI-provider integration in this codebase goes through. Deliberately
 * thin compared to WhatsAppProvider (which models a stateful connection) — this models a single
 * stateless text completion. `complete()` returns text ONLY: no tool-use, no function-calling, no
 * Prisma access, no import of WhatsAppProvider/ProviderRegistry/the outbound queue/worker commands
 * anywhere in this package. That absence is what structurally prevents AI from ever executing a
 * WhatsApp action directly — the only caller (apps/worker/src/learning/aiAnalysisJob.ts) writes
 * the returned text into PatternCandidate columns and nothing else.
 */
export interface AiClient {
  complete(request: AiCompletionRequest): Promise<AiCompletionResult>;
}
