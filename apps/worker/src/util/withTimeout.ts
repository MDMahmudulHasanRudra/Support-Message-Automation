/**
 * Bounds a promise that talks to something this process does not control.
 *
 * Every loop in this worker is a `setInterval` with a manual overlap guard — a boolean held across
 * the whole tick, because `setInterval` does not await its callback. That guard is what keeps two
 * ticks from running at once, and it is also what turns a single never-settling `await` into a
 * permanently dead loop: the flag is never cleared, every subsequent tick returns immediately, and
 * the worker goes on heartbeating with nothing to show that one of its twenty loops has stopped.
 *
 * The calls at risk are the ones into Chromium. Puppeteer's own `protocolTimeout` (180s) bounds
 * most of them, but not all — `kill()` in particular can be waiting on a browser that is itself
 * the thing that has gone wrong. `syncGroupsWithTimeoutAndRetry` has wrapped its call for exactly
 * this reason since a `getAllGroups()` on 1,880 chats took down the whole process; this is that
 * pattern, named once so the next call that needs it does not have to reinvent it.
 *
 * Rejects rather than resolving to a sentinel, so a caller has to decide what a timeout means
 * rather than accidentally treating one as success.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label = "operation"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
