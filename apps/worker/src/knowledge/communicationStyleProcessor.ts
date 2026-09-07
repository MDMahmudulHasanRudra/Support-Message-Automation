import { prisma } from "@support-automation/db";
import { buildCommunicationStyleProfile } from "./communicationStyleJob.js";
import { scheduleStartupCatchUp } from "../scheduling.js";

/**
 * Rebuilds the communication-style profile on a slow cadence.
 *
 * Twelve hours, because a team's manner is one of the slowest-moving things this system tracks —
 * it changes when people change, not when messages arrive — and because every rebuild clears the
 * human approval, so a fast cadence would mean re-approving the same guidance repeatedly for no
 * gain. Anyone wanting it sooner uses the dashboard's "Rebuild now", which is a
 * `BUILD_COMMUNICATION_STYLE` WorkerCommand.
 *
 * Same overlap-guarded setInterval as every other loop here: setInterval does not await its
 * callback, so each needs its own boolean.
 */
export function startCommunicationStyleProcessor(intervalMs = 12 * 60 * 60_000): NodeJS.Timeout {
  let running = false;

  const tick = () => {
    if (running) return Promise.resolve();
    running = true;
    return buildCommunicationStyleProfile()
      .then((result) => {
        if (result.ran && result.guidanceChanged) {
          console.log(`[style] rebuilt from ${result.repliesAnalyzed} replies — awaiting approval`);
        }
      })
      .catch((err) => {
        console.error("[style] unexpected error building the communication style profile", err);
      })
      .finally(() => {
        running = false;
      });
  };

  // Twelve hours is the longest interval in this worker and therefore the easiest to starve
  // entirely — see ../scheduling.ts. Last in the stagger, since a style rebuild is the least
  // urgent of the three and its output waits on human approval anyway.
  scheduleStartupCatchUp({
    name: "Communication style rebuild",
    intervalMs,
    delayMs: 240_000,
    lastRunAt: async () =>
      (await prisma.communicationStyleProfile.findUnique({ where: { id: "global" }, select: { lastBuiltAt: true } }))
        ?.lastBuiltAt ?? null,
    run: tick,
  });

  return setInterval(tick, intervalMs);
}
