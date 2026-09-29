import { forEachProject } from "../project/context.js";
import { processOneConversationAnalysisStep } from "./conversationAnalysisJob.js";

/**
 * Drains the on-demand "Learn from Conversations" queue, one group per tick.
 *
 * 5s rather than the scheduled builder's hour: somebody pressed Analyze and is watching a progress
 * bar, which is the same reasoning that makes the knowledge importer 15s. Slower than the sandbox's
 * 2s because each tick here is a full AI extraction over up to 400 messages, not a single reply.
 *
 * processOneConversationAnalysisStep() no-ops on an empty queue, which is the normal state.
 */
export function startConversationAnalysisProcessor(intervalMs = 5_000): NodeJS.Timeout {
  let processing = false;
  return setInterval(() => {
    if (processing) return;
    processing = true;
    // One pass per project, each in its own project context (MULTI_PROJECT_PLAN.md Phase 3).
    forEachProject("knowledge-builder", () => processOneConversationAnalysisStep())
      .catch((err) => {
        console.error("[knowledge-builder] unexpected error in a conversation analysis step", err);
      })
      .finally(() => {
        processing = false;
      });
  }, intervalMs);
}
