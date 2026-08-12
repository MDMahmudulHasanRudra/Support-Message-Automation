import { processOneCase } from "./escalationQueue.js";

/**
 * Starts the periodic escalation-check loop. Processes at most one due case per tick — same
 * overlap-guarded setInterval pattern as startOutboundQueueProcessor/startCommandProcessor
 * (ENGINEERING_STANDARDS.md §9/§15 "no concurrent duplicate workers"). SLA windows are minutes,
 * not seconds, so this ticks far less often than the outbound queue.
 */
export function startEscalationProcessor(intervalMs = 15_000): NodeJS.Timeout {
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
      });
  }, intervalMs);
}
