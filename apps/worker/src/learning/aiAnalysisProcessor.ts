import { processOneAiAnalysisBatch } from "./aiAnalysisJob.js";

/**
 * Starts the periodic AI-analysis loop. Same overlap-guarded setInterval pattern as every other
 * background job in this worker. Ticks rarely (6h default) since this is the one job that costs
 * real API money — processOneAiAnalysisBatch() itself no-ops immediately whenever AI is
 * unconfigured/disabled (resolveAiClient() returns null), so this interval existing at all has
 * zero cost on a fresh/default install. The dashboard's "Run analysis now" button (a
 * WorkerCommand of type AI_ANALYSIS_BATCH, see commandProcessor.ts) runs the same function
 * on-demand without waiting for this interval.
 */
export function startAiAnalysisProcessor(intervalMs = 6 * 60 * 60_000): NodeJS.Timeout {
  let processing = false;
  return setInterval(() => {
    if (processing) return;
    processing = true;
    processOneAiAnalysisBatch()
      .catch((err) => {
        console.error("[conversation-learning] unexpected error in AI analysis batch", err);
      })
      .finally(() => {
        processing = false;
      });
  }, intervalMs);
}
