import { prisma } from "@support-automation/db";
import { recoverStuckOutboundMessages } from "./queue/outboundQueueProcessor.js";
import { recoverStuckParticipantAddItems } from "./queue/groupParticipantAddProcessor.js";
import { recoverStuckParticipantChecks } from "./queue/groupParticipantCheckProcessor.js";
import { recoverStuckNotifications } from "./notifications/dispatcher.js";
import { recoverStuckCommands } from "./commands/commandProcessor.js";
import { logSystemEvent } from "./logging/logSystemEvent.js";
import { trackTick } from "./lifecycle.js";
import { recordLoopTick, registerLoop } from "./health/loopLiveness.js";

/** Name this loop reports itself under in the per-loop liveness view. */
const LOOP_NAME = "stuck-work-recovery";

/**
 * Un-sticks work that was claimed and never settled, and makes the reported connection state match
 * reality at boot.
 *
 * Every queue in this worker claims a row by flipping it to PROCESSING. If whatever claimed it goes
 * away mid-flight, that row stays PROCESSING and no tick will ever look at it again — a reply, an
 * alert, or a group add that is neither sent nor visibly failed.
 */

/** Five minutes. Long enough that a slow-but-live send is never yanked out from under itself. */
const RECOVERY_INTERVAL_MS = 5 * 60_000;

export interface StuckWorkRecovered {
  outbound: number;
  notifications: number;
  participantAdds: number;
  /** Pairs left mid-roster-read. Counted apart from adds: nothing was sent, so a spike here is a
   *  provider that keeps stalling rather than work that keeps failing. */
  participantChecks: number;
  commands: number;
}

/**
 * `atBoot` reaches exactly one of these four, and it matters.
 *
 * The three queue recoveries are safe either way: each only touches rows past its own `updatedAt`
 * threshold, so a row genuinely being worked on right now is never reclaimed. `recoverStuckCommands`
 * had no threshold at all — see its own doc comment — so on a live worker it was failing commands
 * mid-flight. At boot it still needs none, because nothing can be running yet, and a command
 * claimed by the previous process would otherwise wait out a twenty-minute timer for no reason.
 */
export async function runStuckWorkRecovery(options: { atBoot?: boolean } = {}): Promise<StuckWorkRecovered> {
  const [outbound, notifications, participantAdds, participantChecks, commands] = await Promise.all([
    recoverStuckOutboundMessages(),
    recoverStuckNotifications(),
    recoverStuckParticipantAddItems(),
    recoverStuckParticipantChecks(),
    recoverStuckCommands({ atBoot: options.atBoot }),
  ]);
  return { outbound, notifications, participantAdds, participantChecks, commands };
}

/**
 * Runs the same recovery the worker does at boot, on a schedule.
 *
 * Boot-only was the gap: it assumed the only way to strand a row is for the process to die, which
 * is not true. A send that hangs past its own timeout, a provider call that never settles, a tick
 * killed by an unhandled rejection — any of those leaves a claimed row behind while the worker
 * carries on looking healthy, and the row then waits for the next restart. On a long-running worker
 * that can be weeks.
 *
 * Every one of these is safe to run repeatedly: each only touches rows older than its own stuck
 * threshold, so a row genuinely being worked on right now is never reclaimed. That was asserted
 * here before it was true of all four — `recoverStuckCommands` had no threshold, and this loop is
 * what turned that from a harmless boot-time simplification into commands being failed while they
 * were still running.
 */
export function startStuckWorkRecoveryProcessor(intervalMs = RECOVERY_INTERVAL_MS): NodeJS.Timeout {
  // Declared before the first tick, so a loop that dies on its very first run shows as
  // "never ticked" rather than not appearing in the liveness view at all.
  registerLoop(LOOP_NAME, intervalMs);
  let processing = false;
  return setInterval(() => {
    if (processing) return;
    processing = true;
    void trackTick(async () => {
      const recovered = await runStuckWorkRecovery();
      const total = recovered.outbound + recovered.notifications + recovered.participantAdds + recovered.commands;
      // Silent when there is nothing to do, which is the normal case. A line every five minutes
      // saying "recovered nothing" is how a log stops being read.
      if (total === 0) return;
      console.warn(`[recovery] released stranded work: ${JSON.stringify(recovered)}`);
      await logSystemEvent("WARN", "worker", "Released work that was claimed but never finished", { ...recovered });
    })
      .catch((err) => console.error("[recovery] stuck-work sweep failed", err))
      .finally(() => {
        processing = false;
        // Stamped when the tick FINISHES, which is the only moment that proves the loop is not
        // wedged — a guard that never clears is exactly how one of these dies silently.
        recordLoopTick(LOOP_NAME, intervalMs);
      });
  }, intervalMs);
}

/**
 * Makes every account's stored status true again for a process that has just started.
 *
 * Nothing clears these on the way down — a `docker compose restart`, an OOM kill, a crash, all
 * leave whatever the columns said a moment before. So a worker that has been up for four seconds
 * and holds no session at all reports its accounts CONNECTED, and keeps reporting that for however
 * long the sequential connect loop takes, which on several accounts is minutes. Everything that
 * reads status believes it: the dashboard shows green, the outbound queue's own checks see a
 * connected account, and an operator looking at a real problem sees no sign of one.
 *
 * The rule is simply that this process has not connected anything yet. CONNECTED and RECONNECTING
 * are claims about a live session, so they become DISCONNECTED; the connect loop that runs moments
 * later corrects each one to whatever is actually true.
 * AUTHENTICATION_REQUIRED, SESSION_ERROR and ERROR describe the stored credentials rather than a
 * live socket and survive a restart intact, so they are left alone.
 *
 * Every QR is cleared regardless. WhatsApp rotates the code every twenty or thirty seconds and it
 * belongs to a pairing attempt that died with the last process — one left on screen is not stale
 * data, it is a code that cannot work, and somebody will stand there scanning it.
 */
export async function reconcileAccountStatusesOnBoot(): Promise<number> {
  const stale = await prisma.whatsAppAccount.updateMany({
    // OUTBOUND_PAUSED and RATE_LIMITED used to be listed here too. They are gone from the enum
    // entirely: nothing ever wrote them, and they described a per-account throttling mechanism
    // that does not exist while being rendered on the Accounts page as real states.
    where: { status: { in: ["CONNECTED", "RECONNECTING"] } },
    data: { status: "DISCONNECTED" },
  });

  await prisma.whatsAppAccount.updateMany({
    where: { qrCode: { not: null } },
    data: { qrCode: null, qrUpdatedAt: null },
  });

  // The stage goes with the QR, and for the same reason: it describes where an attempt had got to
  // in a process that no longer exists. Left behind, a card would report "WhatsApp accepted the
  // link — getting the session ready" about a session that died mid-sentence, which is the single
  // most misleading thing this column could say. Separate from the QR sweep above because a stage
  // outlives the code — an attempt that authenticated has already had its QR cleared.
  await prisma.whatsAppAccount.updateMany({
    where: { connectionStage: { not: null } },
    data: { connectionStage: null },
  });

  if (stale.count > 0) {
    console.log(`[recovery] reset ${stale.count} account(s) from a status left behind by the previous process`);
    await logSystemEvent("INFO", "worker", "Reset connection status left behind by the previous process", {
      accounts: stale.count,
    });
  }

  return stale.count;
}
