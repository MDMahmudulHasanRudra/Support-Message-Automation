import { forEachProject } from "../project/context.js";
import { processOneSegmentationBatch } from "./sessionSegmentation.js";

/**
 * Starts the periodic conversation-session segmentation loop. Same overlap-guarded setInterval
 * pattern as startEscalationProcessor/startOutboundQueueProcessor (ENGINEERING_STANDARDS.md
 * §9/§15 "no concurrent duplicate workers"). Ticks far less often than the outbound queue since
 * this is background learning, not latency-sensitive delivery — and processOneSegmentationBatch
 * itself no-ops immediately whenever LearningSettings.conversationLearningEnabled is false.
 */
export function startSessionSegmentationProcessor(intervalMs = 5 * 60_000): NodeJS.Timeout {
  let processing = false;
  return setInterval(() => {
    if (processing) return;
    processing = true;
    // One pass per project, each in its own project context (MULTI_PROJECT_PLAN.md Phase 3).
    forEachProject("conversation-learning", () => processOneSegmentationBatch())
      .catch((err) => {
        console.error("[conversation-learning] unexpected error in session segmentation batch", err);
      })
      .finally(() => {
        processing = false;
      });
  }, intervalMs);
}
