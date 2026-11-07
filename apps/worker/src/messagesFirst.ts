/**
 * Customers come first. A slow job (Groups Admin Maker, Add to Groups, group re-reads) drives the same
 * WhatsApp browser that receives and answers messages, so while a message is being handled or a reply is
 * going out, it stands back and takes its turn a moment later. These jobs may take hours; a customer's reply
 * may not.
 *
 * This decides only WHEN a slow job's next tick runs. It never touches a message, a send or a job's state,
 * so a restart loses nothing, and a slow job is never starved: on a number that never goes quiet it still
 * takes a turn at least every MAX_WAIT_MS.
 */

/** How long after the last send slow jobs keep waiting: long enough for the queue's next 2 s tick. */
export const QUIET_AFTER_MS = 2_500;
export const MAX_WAIT_MS = 45_000;
/** The longest a group sync waits between two batches of writes. */
export const BATCH_WAIT_MS = 3_000;

let handling = 0;
let lastSendAt = 0;
const lastTurn = new Map<string, number>();

/** Wrapped around handling one incoming message, from the provider's handover to the end of its pipeline. */
export async function trackMessageWork<T>(work: () => Promise<T>): Promise<T> {
  handling += 1;
  try {
    return await work();
  } finally {
    handling -= 1;
  }
}

/** The outbound queue took a row. */
export function noteOutboundSend(now = Date.now()): void {
  lastSendAt = now;
}

export function messageWorkInProgress(now = Date.now()): boolean {
  return handling > 0 || now - lastSendAt < QUIET_AFTER_MS;
}

/** At the top of a slow job's tick: false means skip this tick, the loop comes round again by itself. */
export function slowJobMayRun(loop: string, now = Date.now()): boolean {
  const last = lastTurn.get(loop);
  if (messageWorkInProgress(now) && (last === undefined || now - last < MAX_WAIT_MS)) {
    if (last === undefined) lastTurn.set(loop, now);
    return false;
  }
  lastTurn.set(loop, now);
  return true;
}

/** Between batches of a long job that cannot simply skip a tick. */
export async function waitForMessagesToClear(maxMs = BATCH_WAIT_MS): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (messageWorkInProgress() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** For tests. */
export function resetMessagesFirst(): void {
  handling = 0;
  lastSendAt = 0;
  lastTurn.clear();
}
