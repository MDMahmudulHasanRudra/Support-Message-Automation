import { prisma } from "../db.js";
import { processOneAiAnalysisBatch } from "./aiAnalysisJob.js";
import { scheduleStartupCatchUpPerProject } from "../scheduling.js";
import { forEachProject } from "../project/context.js";

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

  // One overlap guard covers both the interval (every project in turn) and the boot catch-up (one
  // overdue project at a time), so the two can never run a batch concurrently.
  const guarded = (work: () => Promise<unknown>) => {
    if (processing) return Promise.resolve();
    processing = true;
    return work()
      .catch((err) => {
        console.error("[conversation-learning] unexpected error in AI analysis batch", err);
      })
      .finally(() => {
        processing = false;
      });
  };
  const tick = () => guarded(() => forEachProject("conversation-learning", () => processOneAiAnalysisBatch()));

  // Six hours outlasts a deploy cycle, so a plain interval can be reset forever — see
  // ../scheduling.ts. Staggered behind the Forge catch-up: both spend API calls, and starting
  // them together on a freshly booted worker is the one moment there is least to spare.
  scheduleStartupCatchUpPerProject({
    name: "AI analysis batch",
    intervalMs,
    delayMs: 150_000,
    lastRunAt: async () =>
      (
        await prisma.learningBatchJob.findFirst({
          where: { jobType: "AI_ANALYSIS", completedAt: { not: null } },
          orderBy: { completedAt: "desc" },
          select: { completedAt: true },
        })
      )?.completedAt ?? null,
    run: () => guarded(() => processOneAiAnalysisBatch()),
  });

  return setInterval(tick, intervalMs);
}
