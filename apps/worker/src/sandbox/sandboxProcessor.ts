import { forEachProject } from "../project/context.js";
import { processOneSandboxTurn } from "./sandboxJob.js";

/**
 * Drains the AI Sandbox queue. Same overlap-guarded setInterval shape as every other
 * background job here.
 *
 * Ticks fast (2s) because somebody is sitting in front of the chat waiting for the reply —
 * the same reasoning that makes the knowledge importer 15s rather than hourly, taken one
 * step further because this is a conversation rather than a job.
 *
 * Deliberately its OWN loop rather than a WorkerCommand. The command processor is strictly
 * serial and shared with RECONNECT/LOGOUT, so routing sandbox turns through it would
 * put an operator's WhatsApp reconnect behind however many test messages somebody is typing —
 * a testing surface must not be able to delay a real recovery.
 *
 * processOneSandboxTurn() no-ops immediately when the queue is empty, which it almost always
 * is, so the resting cost of this loop is one indexed lookup every two seconds.
 */
export function startSandboxProcessor(intervalMs = 2_000): NodeJS.Timeout {
  let processing = false;
  return setInterval(() => {
    if (processing) return;
    processing = true;
    // One pass per project, each in its own project context (MULTI_PROJECT_PLAN.md Phase 3).
    forEachProject("sandbox", () => processOneSandboxTurn())
      .catch((err) => {
        console.error("[sandbox] unexpected error processing a turn", err);
      })
      .finally(() => {
        processing = false;
      });
  }, intervalMs);
}
