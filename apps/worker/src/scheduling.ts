/**
 * Boot-time catch-up for the slow background loops.
 *
 * Every loop in this worker is a plain `setInterval`, which starts counting from the moment the
 * process starts and keeps no memory across restarts. For a two-second queue drain that is
 * invisible. For a six- or twelve-hour job it is a hole: a worker restarted more often than its
 * own interval never reaches the first tick, so the job simply never runs, and nothing says so.
 *
 * This is not hypothetical. Three deploys in one afternoon left the Forge knowledge sync — a
 * six-hour loop — twenty-seven hours stale, and the only visible sign was a "last synced"
 * timestamp on a settings page that looks like a slow schedule rather than a stopped one.
 *
 * So each slow loop also asks, once, shortly after boot: when did this last actually finish? If
 * that was longer ago than one interval, it is overdue, and it runs now instead of waiting out a
 * fresh interval that the next deploy may cut short again.
 *
 * Two deliberate properties:
 *
 * - **It waits before it runs.** Boot is the busiest moment in this process — accounts connect
 *   sequentially, each starting a Chromium — and a catch-up that fires into that competes with
 *   the one thing a support system cannot be slow about. The default delay is a minute, and
 *   callers stagger past that so two expensive jobs never start together.
 * - **It never needs its own enable check.** Every job it runs already no-ops when its feature is
 *   off or unconfigured, which is what makes running one "just in case" free on a fresh install.
 *   Adding gating here would duplicate that and drift from it.
 */

export interface StartupCatchUpOptions {
  /** Used only in the log line explaining why a job ran early. */
  name: string;
  /** The loop's own interval. Overdue means "last finished longer ago than this". */
  intervalMs: number;
  /** When the work last completed. Null means never, which counts as overdue. */
  lastRunAt: () => Promise<Date | null>;
  run: () => Promise<unknown>;
  /** How long after boot to check. Stagger this across callers. */
  delayMs?: number;
}

const DEFAULT_DELAY_MS = 60_000;

/**
 * Returns the timer so a caller can clear it, matching what the `start*Processor` functions do.
 * Never throws: a catch-up that cannot read its own timestamp must leave the ordinary interval
 * running rather than take the worker down with it.
 */
export function scheduleStartupCatchUp(options: StartupCatchUpOptions): NodeJS.Timeout {
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;

  const timer = setTimeout(() => {
    void (async () => {
      try {
        const lastRunAt = await options.lastRunAt();
        const overdueBy = lastRunAt ? Date.now() - lastRunAt.getTime() : null;
        if (overdueBy !== null && overdueBy < options.intervalMs) return;

        console.log(
          `[scheduler] ${options.name} is overdue (` +
            (lastRunAt ? `last completed ${Math.round((overdueBy ?? 0) / 60_000)} minutes ago` : "never completed") +
            `, interval ${Math.round(options.intervalMs / 60_000)} minutes) — running it now rather than waiting for the next tick`,
        );
        await options.run();
      } catch (err) {
        console.error(`[scheduler] catch-up run for ${options.name} failed`, err);
      }
    })();
  }, delayMs);

  // Never hold the process open for a catch-up that has not fired yet: a worker asked to shut
  // down thirty seconds after booting should shut down.
  timer.unref?.();
  return timer;
}
