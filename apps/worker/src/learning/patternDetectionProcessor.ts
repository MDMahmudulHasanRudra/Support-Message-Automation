import { processOnePatternDetectionBatch } from "./patternDetectionJob.js";

/**
 * Starts the periodic pattern-detection loop. Same overlap-guarded setInterval pattern as every
 * other background job in this worker. Ticks less often than segmentation (15 min vs 5 min) since
 * it does more per-session work; processOnePatternDetectionBatch() itself no-ops immediately
 * whenever LearningSettings.conversationLearningEnabled is false.
 */
export function startPatternDetectionProcessor(intervalMs = 15 * 60_000): NodeJS.Timeout {
  let processing = false;
  return setInterval(() => {
    if (processing) return;
    processing = true;
    processOnePatternDetectionBatch()
      .catch((err) => {
        console.error("[conversation-learning] unexpected error in pattern detection batch", err);
      })
      .finally(() => {
        processing = false;
      });
  }, intervalMs);
}
