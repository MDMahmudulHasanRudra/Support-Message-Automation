import { processOneCase } from "./escalationQueue.js";
import { recordLoopTick, registerLoop } from "../health/loopLiveness.js";

/** Name this loop reports itself under in the per-loop liveness view. */
const LOOP_NAME = "escalation";

/**
 * Starts the periodic escalation-check loop. Processes at most one due case per tick — same
 * overlap-guarded setInterval pattern as startOutboundQueueProcessor/startCommandProcessor
 * (ENGINEERING_STANDARDS.md §9/§15 "no concurrent duplicate workers"). SLA windows are minutes,
 * not seconds, so this ticks far less often than the outbound queue.
 */
export function startEscalationProcessor(intervalMs = 15_000): NodeJS.Timeout {
  // Declared before the first tick, so a loop that dies on its very first run shows as
  // "never ticked" rather than not appearing in the liveness view at all.
  registerLoop(LOOP_NAME, intervalMs);
  let processing = false;
  return setInterval(() => {
    if (processing) return;
    processing = true;
    processOneCase()
      .catch((err) => {
        console.error("[escalation] unexpected error processing a support escalation case", err);
      })
      .finally(() => {
        processing = false;
        // Stamped when the tick FINISHES, which is the only moment that proves the loop is not
        // wedged — a guard that never clears is exactly how one of these dies silently.
        recordLoopTick(LOOP_NAME, intervalMs);
      });
  }, intervalMs);
}
