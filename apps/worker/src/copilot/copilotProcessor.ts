import { forEachProject } from "../project/context.js";
import { registerLoop, recordLoopTick } from "../health/loopLiveness.js";
import { processOneCopilotRequest } from "./copilotJob.js";

const LOOP_NAME = "ai-copilot";

/**
 * Drains AI Copilot requests (INBOX_WORKSPACE.md). Its own loop rather than a WorkerCommand for the
 * sandbox's reason: the command processor is strictly serial and shared with RECONNECT/LOGOUT, and
 * an agent asking for a draft must never queue in front of a WhatsApp recovery. 2 s because an agent
 * is waiting; one request per project per tick, and an empty queue costs one indexed lookup.
 */
export function startCopilotProcessor(intervalMs = 2_000): NodeJS.Timeout {
  registerLoop(LOOP_NAME, intervalMs);
  let processing = false;
  return setInterval(() => {
    if (processing) return;
    processing = true;
    forEachProject(LOOP_NAME, () => processOneCopilotRequest())
      .catch((err) => console.error("[copilot] unexpected error processing a request", err))
      .finally(() => {
        processing = false;
        recordLoopTick(LOOP_NAME, intervalMs);
      });
  }, intervalMs);
}
