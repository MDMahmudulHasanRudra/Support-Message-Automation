import { logSystemEvent } from "./logging/logSystemEvent.js";

/**
 * Process lifecycle: whether this worker is on its way down, and whether anything is still in the
 * middle of doing something.
 *
 * `clearInterval` stops the NEXT tick; it says nothing about the one already running. Without this,
 * SIGTERM during a send meant the container went away mid-`sendText` — the message may or may not
 * have reached WhatsApp, and its row stayed PROCESSING until the next boot's crash recovery pushed
 * it back to PENDING and sent it again. Rare, and exactly the kind of rare that shows up as a
 * customer receiving the same reply twice.
 *
 * Deliberately applied only to the loops that act outward or claim a queue row — outbound sends,
 * notifications, group-participant adds, dashboard commands. The learning, knowledge and Forge
 * loops write only their own records and are genuinely safe to cut off: their next tick starts over.
 */

let shuttingDown = false;
let inFlight = 0;

/** True once a shutdown signal has been received. Every claiming loop checks this before claiming. */
export function isShuttingDown(): boolean {
  return shuttingDown;
}

export function beginShutdown(): void {
  shuttingDown = true;
}

/**
 * Wraps one tick of a polling loop so shutdown can wait for it.
 *
 * Returns without running when a shutdown is already underway — the point is not to start work
 * nobody will be around to finish. A loop whose interval has been cleared can still have one
 * scheduled callback about to fire, so this guard is what actually stops new claims.
 */
export async function trackTick<T>(run: () => Promise<T>): Promise<T | undefined> {
  if (shuttingDown) return undefined;
  inFlight += 1;
  try {
    return await run();
  } finally {
    inFlight -= 1;
  }
}

/**
 * Waits for in-flight ticks to finish, up to `timeoutMs`.
 *
 * Bounded, never indefinite: a tick blocked on a hung provider call would otherwise hold the
 * container open until the orchestrator killed it anyway, which is a worse version of the same
 * outcome with a longer wait and a SIGKILL at the end. Returns whether everything settled, so the
 * caller can say which of the two happened rather than reporting a clean shutdown either way.
 */
export async function awaitQuiescence(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (inFlight > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return inFlight === 0;
}

/**
 * Keeps one missed `.catch()` from taking down every loop in this process.
 *
 * Node's default for an unhandled rejection is to throw, which kills the worker — so a single
 * forgotten catch in any of the eighteen loops stops WhatsApp collection, the outbound queue,
 * escalation timers and everything else, and the only symptom is a container that restarted.
 * There are a lot of fire-and-forget promises in here by design (the escalation hook, the support
 * activity hook, the AI fallback stage all deliberately do not gate message processing), which is
 * precisely the pattern that produces one.
 *
 * The two cases are treated differently on purpose:
 *
 * - An unhandled **rejection** is one failed operation. The rest of the process is fine, so it is
 *   recorded loudly and the worker keeps running. Losing every other loop over it would turn one
 *   failed message into a total outage.
 * - An uncaught **exception** unwound a stack to the top and left unknown state behind. Continuing
 *   would mean running on state nobody can reason about, so this records it and exits non-zero for
 *   the container's restart policy to handle — where boot-time crash recovery requeues whatever was
 *   mid-flight. Restarting is the safe response; pretending nothing happened is not.
 */
export function installProcessGuards(): void {
  process.on("unhandledRejection", (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    console.error("[worker] unhandled promise rejection — worker continues", error);
    void logSystemEvent("ERROR", "worker", "Unhandled promise rejection", {
      error: error.message,
      stack: error.stack,
    }).catch(() => undefined);
  });

  process.on("uncaughtException", (err) => {
    console.error("[worker] uncaught exception — exiting for a clean restart", err);
    // Best effort, with a hard bound: the process is already in an unknown state, and waiting
    // forever on a database write to describe that is how a crash becomes a hang.
    const exit = () => process.exit(1);
    void logSystemEvent("ERROR", "worker", "Uncaught exception — worker is restarting", {
      error: err.message,
      stack: err.stack,
    })
      .catch(() => undefined)
      .finally(exit);
    setTimeout(exit, 3_000).unref();
  });
}
