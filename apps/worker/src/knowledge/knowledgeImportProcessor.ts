import { processOneKnowledgeImport } from "./knowledgeImportJob.js";

/**
 * Drains the knowledge-import queue. Same overlap-guarded setInterval pattern as every other
 * background job in this worker.
 *
 * Ticks often (15s) because an import is something a person just submitted and is watching the
 * progress of — unlike the hourly conversation builder, which nobody is waiting on. Each tick
 * processes at most one import, and processOneKnowledgeImport() no-ops immediately when the
 * queue is empty, which is almost always.
 */
export function startKnowledgeImportProcessor(intervalMs = 15_000): NodeJS.Timeout {
  let processing = false;
  return setInterval(() => {
    if (processing) return;
    processing = true;
    processOneKnowledgeImport()
      .catch((err) => {
        console.error("[knowledge-import] unexpected error processing an import", err);
      })
      .finally(() => {
        processing = false;
      });
  }, intervalMs);
}
