import { processOneGroupKnowledgeBuild } from "./groupKnowledgeJob.js";

/**
 * Starts the periodic group-knowledge loop. Same overlap-guarded setInterval pattern as every
 * other background job in this worker.
 *
 * Ticks slowly and does exactly one group per tick, because this job costs real API money and
 * reads whole conversations. At the default hour, a hundred-group deployment works through its
 * whole estate in about four days and then only revisits a group when it has enough new
 * conversation to be worth re-reading. processOneGroupKnowledgeBuild() no-ops immediately when
 * the feature is off — which it is by default — so this interval existing at all costs nothing
 * on a normal install. The dashboard's "Build knowledge now" button
 * (a BUILD_GROUP_KNOWLEDGE WorkerCommand, see commandProcessor.ts) runs the same function
 * on-demand for one chosen group.
 */
export function startGroupKnowledgeProcessor(intervalMs = 60 * 60_000): NodeJS.Timeout {
  let processing = false;
  return setInterval(() => {
    if (processing) return;
    processing = true;
    processOneGroupKnowledgeBuild()
      .catch((err) => {
        console.error("[knowledge-builder] unexpected error building group knowledge", err);
      })
      .finally(() => {
        processing = false;
      });
  }, intervalMs);
}
