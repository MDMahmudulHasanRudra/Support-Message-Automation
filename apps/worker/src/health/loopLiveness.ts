/**
 * When each polling loop last completed a tick.
 *
 * The heartbeat proves that ONE `setInterval` fires. It shares nothing with the other twenty loops
 * — not a lock, not a queue, not a counter — so "the worker is alive" has always meant exactly
 * "the heartbeat's own timer is still scheduled", and that stays true while the outbound queue,
 * the command processor or the registry sync sits wedged on a call into a browser that never
 * answers. Each of those is an overlap-guarded loop whose guard, once stuck, silently converts
 * every later tick into a no-op.
 *
 * This is the smallest thing that distinguishes them: a name and a timestamp per loop, stamped
 * when a tick finishes. A loop that has not completed a tick in many times its own interval has
 * stopped, whatever the heartbeat says.
 *
 * In memory, like `metrics.ts` and for the same reason: the question is what THIS process is
 * doing. A table would answer it for some process, which is not the question.
 */

export interface LoopLiveness {
  name: string;
  /** Milliseconds between ticks, so "overdue" is relative to the loop rather than a global guess. */
  intervalMs: number;
  /** Null until the first tick completes — a loop registered at boot has not run yet. */
  lastTickAt: number | null;
  /** Ticks that have finished since this process started. */
  ticks: number;
}

const loops = new Map<string, LoopLiveness>();

/** Declared at registration so a loop appears as "never ticked" rather than not appearing at all. */
export function registerLoop(name: string, intervalMs: number): void {
  if (!loops.has(name)) loops.set(name, { name, intervalMs, lastTickAt: null, ticks: 0 });
}

export function recordLoopTick(name: string, intervalMs: number): void {
  const existing = loops.get(name);
  if (existing) {
    existing.lastTickAt = Date.now();
    existing.ticks += 1;
    return;
  }
  loops.set(name, { name, intervalMs, lastTickAt: Date.now(), ticks: 1 });
}

/**
 * How overdue a loop is, as a multiple of its own interval.
 *
 * A multiple rather than an absolute age, because these intervals span 1.5 seconds to twelve
 * hours and one threshold cannot describe both. Three is the factor: a loop whose tick can take
 * longer than its interval (the registry sync connecting an account, the command processor running
 * a group resync) legitimately skips one or two, and none of them legitimately skips three.
 */
const OVERDUE_FACTOR = 3;

export interface LoopReport extends LoopLiveness {
  /** Null while a loop has never ticked — which at boot is normal, not overdue. */
  overdueBy: number | null;
  stalled: boolean;
}

export function readLoops(nowMs = Date.now()): LoopReport[] {
  return [...loops.values()]
    .map((loop) => {
      // A loop that has never ticked is measured from process start, not treated as healthy —
      // otherwise one that failed on its very first tick would look permanently fine.
      const since = loop.lastTickAt === null ? null : nowMs - loop.lastTickAt;
      const overdueBy = since === null ? null : since / loop.intervalMs;
      return { ...loop, overdueBy, stalled: overdueBy !== null && overdueBy > OVERDUE_FACTOR };
    })
    .sort((a, b) => (b.overdueBy ?? -1) - (a.overdueBy ?? -1));
}

/** The loop furthest past its own schedule, or null when every one of them is on time. */
export function stalestLoop(nowMs = Date.now()): LoopReport | null {
  return readLoops(nowMs).find((loop) => loop.stalled) ?? null;
}

/** Test seam. */
export function resetLoops(): void {
  loops.clear();
}
