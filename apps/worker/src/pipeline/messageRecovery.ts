import { countMetric } from "../health/metrics.js";
import { prisma } from "@support-automation/db";
import { loadStoredMessageContext, runAutomationStage } from "./processIncomingMessage.js";
import { logSystemEvent } from "../logging/logSystemEvent.js";
import { trackTick } from "../lifecycle.js";

/**
 * Finishes messages that were stored and then never processed.
 *
 * `processIncomingMessage` writes the `Message` row first, deliberately: that row is the dedup
 * guard, and it has to exist before any work that could fire twice. The cost is a window — between
 * the insert and the status settle — where the process going away leaves the row `PENDING`
 * forever. And because the row exists, WhatsApp's own redelivery then hits P2002 and returns
 * "already processed". The customer's question sat in the database, visible in the inbox, with no
 * rule ever evaluated against it and nothing anywhere reporting a problem.
 *
 * That window is small and it is hit by every restart, every crash, and every unhandled rejection
 * that lands mid-pipeline. This closes it.
 *
 * Re-running is safe by construction rather than by hope — see `runAutomationStage`'s own comment
 * for the four keyed writes that make a second pass converge instead of duplicating.
 */

const RECOVERY_INTERVAL_MS = 2 * 60_000;

/**
 * How long a row must have sat `PENDING` before it counts as stranded rather than in progress. The
 * pipeline includes an AI call with a retry budget, so a message legitimately mid-flight can be a
 * minute or more old; picking one up early would run it twice concurrently.
 */
const STRANDED_AFTER_MS = 5 * 60_000;

/**
 * The far edge. Beyond this a stranded message is history rather than an outstanding question, and
 * running rules over it would answer something nobody is still waiting on — the same reasoning as
 * the catch-up sweep's automation window, and the same conclusion.
 */
const TOO_OLD_MS = 6 * 60 * 60_000;

/** One pass handles a bounded batch; anything larger is a backlog, and a backlog wants several passes. */
const BATCH_SIZE = 25;

export interface MessageRecoveryResult {
  found: number;
  recovered: number;
  failed: number;
}

/**
 * Never throws. Runs on a timer beside everything else, and one bad row must not stop the sweep.
 */
export async function recoverStrandedMessages(batchSize = BATCH_SIZE): Promise<MessageRecoveryResult> {
  const now = Date.now();
  const result: MessageRecoveryResult = { found: 0, recovered: 0, failed: 0 };

  const stranded = await prisma.message.findMany({
    where: {
      direction: "INCOMING",
      processingStatus: "PENDING",
      createdAt: { lt: new Date(now - STRANDED_AFTER_MS), gt: new Date(now - TOO_OLD_MS) },
    },
    orderBy: { timestampWa: "asc" },
    take: batchSize,
    select: { id: true },
  });

  result.found = stranded.length;
  if (stranded.length === 0) return result;

  for (const { id } of stranded) {
    try {
      const context = await loadStoredMessageContext(id);
      if (!context) continue; // deleted between the query and now
      await runAutomationStage(context.raw, context.stored, `recovery:${id}`);
      result.recovered += 1;
      countMetric("retried");
    } catch (err) {
      // runAutomationStage already marked the row FAILED and logged the detail. FAILED is not
      // picked up again, so a message that cannot be processed is retried exactly once and then
      // left visibly failed rather than looping over the same error every two minutes.
      result.failed += 1;
      console.error(`[message-recovery] could not finish message ${id}`, err);
    }
  }

  console.warn(`[message-recovery] ${JSON.stringify(result)}`);
  await logSystemEvent(
    result.failed > 0 ? "ERROR" : "WARN",
    "pipeline",
    "Finished messages that were stored but never processed",
    { ...result },
  ).catch(() => undefined);

  return result;
}

/**
 * Every two minutes. Frequent enough that a restart's casualties are answered while the customer is
 * still in the conversation, infrequent enough to cost one indexed query against
 * `Message.processingStatus` when there is nothing to do — which is almost always.
 */
export function startMessageRecoveryProcessor(intervalMs = RECOVERY_INTERVAL_MS): NodeJS.Timeout {
  let processing = false;
  return setInterval(() => {
    if (processing) return;
    processing = true;
    void trackTick(() => recoverStrandedMessages())
      .catch((err) => console.error("[message-recovery] sweep failed", err))
      .finally(() => {
        processing = false;
      });
  }, intervalMs);
}
