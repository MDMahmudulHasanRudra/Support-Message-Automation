import { forEachProject } from "../project/context.js";
import { registerLoop, recordLoopTick } from "../health/loopLiveness.js";
import { processOneSocialAiRequest } from "./socialAiJob.js";

const LOOP_NAME = "social-ai";

/**
 * Answers Social Studio AI Content Studio requests (SOCIAL_STUDIO.md §AI). Its own loop, like the Copilot:
 * someone is waiting for the answer and it must never queue behind WhatsApp commands. It publishes
 * nothing and touches no WhatsApp session. An empty queue costs one indexed lookup per project.
 */
export function startSocialAiProcessor(intervalMs = 2_000): NodeJS.Timeout {
  registerLoop(LOOP_NAME, intervalMs);
  let processing = false;
  return setInterval(() => {
    if (processing) return;
    processing = true;
    forEachProject(LOOP_NAME, () => processOneSocialAiRequest())
      .catch((err) => console.error("[social-ai] unexpected error processing a request", err))
      .finally(() => {
        processing = false;
        recordLoopTick(LOOP_NAME, intervalMs);
      });
  }, intervalMs);
}
