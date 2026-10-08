import type { AiFailureDescription } from "@support-automation/shared";

/**
 * One shared retry policy for every AI provider call, so a single rate limit can no longer cost a
 * customer their answer. Before this, one 429 or 502 permanently lost that message, and one blip
 * during a 30-chunk manual import left the whole import PARTIAL with a section missing.
 *
 * Deliberately small: the AI fallback runs inside a message's own pipeline pass, so retrying is a
 * latency budget, not a reliability blank cheque. Only 429 and 5xx are retried — a 401/403/404 is
 * a configuration fact that will be equally true one second later.
 */

/** Up to two retries after the first attempt. */
export const MAX_ATTEMPTS = 3;
/** Ceiling on any single wait, including one the provider asked for via Retry-After. */
export const MAX_RETRY_WAIT_MS = 8_000;
/** Total extra wall-clock time retrying may add on top of one attempt's own timeout. */
export const RETRY_EXTRA_BUDGET_MS = 20_000;

/** Thrown by every client in this package, so a caller can tell a blip from a misconfiguration. */
export class AiProviderCallError extends Error {
  readonly transient: boolean;
  readonly status?: number;
  /** How long the provider itself asked us to wait, when it said so via Retry-After. */
  readonly retryAfterMs?: number | null;

  constructor(message: string, options: { transient: boolean; status?: number; retryAfterMs?: number | null }) {
    super(message);
    this.name = "AiProviderCallError";
    this.transient = options.transient;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

export function isRetriableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Retry-After is either seconds or an HTTP date; both forms appear in the wild. */
export function parseRetryAfterMs(header: string | null | undefined): number | null {
  if (!header) return null;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds)) return Math.max(0, Math.min(seconds * 1000, MAX_RETRY_WAIT_MS));
  const asDate = Date.parse(header);
  if (!Number.isNaN(asDate)) return Math.max(0, Math.min(asDate - Date.now(), MAX_RETRY_WAIT_MS));
  return null;
}

/** 500ms, then 1500ms. No jitter: one process making one call at a time is not a thundering herd. */
export function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** (attempt - 1) + (attempt - 1) * 500, MAX_RETRY_WAIT_MS);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A timeout is never retried even though it classifies as transient: the caller's whole point in
 * setting a timeout was to bound how long one message can block, and a second full-length attempt
 * would defeat that. AnthropicClient's `maxRetries: 0` encodes the same decision.
 */
export function shouldRetry(description: AiFailureDescription, isTimeout: boolean, attempt: number): boolean {
  return description.transient && !isTimeout && attempt < MAX_ATTEMPTS;
}
