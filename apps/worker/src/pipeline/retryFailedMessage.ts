import type { RawIncomingMessage } from "./types.js";
import { processIncomingMessage } from "./processIncomingMessage.js";
import { countDroppedMessage } from "./dropCounter.js";
import { logSystemEvent } from "../logging/logSystemEvent.js";

/**
 * Gives a message that failed to process a few more chances before it is written off.
 *
 * `processIncomingMessage` throws for transient reasons — a pool timeout, a restarting database, a
 * dropped connection. The caller used to log it, count it and move on, so a one-second database
 * blip became a permanently lost customer message: nothing re-offered it until the session next
 * reconnected, and the watchdog only looks at a number that has stored NOTHING for 45 minutes.
 *
 * Retrying is safe by construction. The `Message` row is the dedup guard: if the first attempt got
 * as far as writing it, the retry reports "already processed" and the row, if it is stranded
 * PENDING, is finished by `messageRecovery.ts`; if the first attempt failed before the write, the
 * retry writes it. Every write after that point is idempotent (see `runAutomationStage`).
 *
 * In memory on purpose, and bounded. If the process dies with retries pending, the reconnect
 * catch-up and `reconcileRecentMessages` re-offer the message from WhatsApp's own history — a table
 * of retries would only be a second, drifting copy of what the `Message` table already says.
 */
export const RETRY_DELAYS_MS = [3_000, 15_000, 60_000];

/** More waiting retries than this means the database is down; piling on timers helps nobody. */
export const MAX_PENDING_RETRIES = 500;

let pending = 0;

export function pendingRetryCount(): number {
  return pending;
}

type Processor = (raw: RawIncomingMessage) => Promise<void>;

/**
 * Runs `process` now and, on a throw, retries on `RETRY_DELAYS_MS`. Resolves once the first attempt
 * has settled; later attempts run on timers and never throw to anyone.
 */
export async function processWithRetry(
  raw: RawIncomingMessage,
  process: Processor = processIncomingMessage,
  delaysMs: readonly number[] = RETRY_DELAYS_MS,
): Promise<void> {
  try {
    await process(raw);
    return;
  } catch (err) {
    console.error(`[worker] error processing incoming message ${raw.whatsappMessageId}`, err);
    scheduleRetry(raw, process, delaysMs, 0, err);
  }
}

function giveUp(raw: RawIncomingMessage, err: unknown, attempts: number): void {
  // The same record the failure always left; it is only written once every chance has been used.
  countDroppedMessage(raw.accountId, "PIPELINE_ERROR");
  void logSystemEvent("ERROR", "pipeline", "Error processing incoming message", {
    error: (err as Error)?.message ?? String(err),
    accountId: raw.accountId,
    attempts,
    note: "Retried and still failing. The message is re-offered from WhatsApp's own history by the recent-message check.",
  }).catch(() => undefined);
}

function scheduleRetry(raw: RawIncomingMessage, process: Processor, delaysMs: readonly number[], attempt: number, lastErr: unknown): void {
  const delay = delaysMs[attempt];
  if (delay === undefined || pending >= MAX_PENDING_RETRIES) {
    giveUp(raw, lastErr, attempt + 1);
    return;
  }
  pending += 1;
  const timer = setTimeout(() => {
    pending -= 1;
    process(raw).then(
      () => {
        console.log(`[worker] message ${raw.whatsappMessageId} processed on retry ${attempt + 1}`);
      },
      (err: unknown) => {
        console.error(`[worker] retry ${attempt + 1} failed for message ${raw.whatsappMessageId}`, err);
        scheduleRetry(raw, process, delaysMs, attempt + 1, err);
      },
    );
  }, delay);
  timer.unref?.();
}
