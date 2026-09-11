import { prisma } from "@support-automation/db";
import { recoverStuckOutboundMessages } from "./queue/outboundQueueProcessor.js";
import { recoverStuckParticipantAddItems } from "./queue/groupParticipantAddProcessor.js";
import { recoverStuckNotifications } from "./notifications/dispatcher.js";
import { recoverStuckCommands } from "./commands/commandProcessor.js";
import { logSystemEvent } from "./logging/logSystemEvent.js";
import { trackTick } from "./lifecycle.js";

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
  commands: number;
}

export async function runStuckWorkRecovery(): Promise<StuckWorkRecovered> {
  const [outbound, notifications, participantAdds, commands] = await Promise.all([
    recoverStuckOutboundMessages(),
    recoverStuckNotifications(),
    recoverStuckParticipantAddItems(),
    recoverStuckCommands(),
  ]);
  return { outbound, notifications, participantAdds, commands };
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
 * Every one of these is already written to be safe to run repeatedly: each only touches rows whose
 * `updatedAt` is older than its own stuck threshold, so a row genuinely being worked on right now
 * is never reclaimed.
 */
export function startStuckWorkRecoveryProcessor(intervalMs = RECOVERY_INTERVAL_MS): NodeJS.Timeout {
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
 * The rule is simply that this process has not connected anything yet. CONNECTED, RECONNECTING and
 * the two throttle states are claims about a live session, so they become DISCONNECTED; the connect
 * loop that runs moments later corrects each one to whatever is actually true.
 * AUTHENTICATION_REQUIRED, SESSION_ERROR and ERROR describe the stored credentials rather than a
 * live socket and survive a restart intact, so they are left alone.
 *
 * Every QR is cleared regardless. WhatsApp rotates the code every twenty or thirty seconds and it
 * belongs to a pairing attempt that died with the last process — one left on screen is not stale
 * data, it is a code that cannot work, and somebody will stand there scanning it.
 */
export async function reconcileAccountStatusesOnBoot(): Promise<number> {
  const stale = await prisma.whatsAppAccount.updateMany({
    where: { status: { in: ["CONNECTED", "RECONNECTING", "OUTBOUND_PAUSED", "RATE_LIMITED"] } },
    data: { status: "DISCONNECTED" },
  });

  await prisma.whatsAppAccount.updateMany({
    where: { qrCode: { not: null } },
    data: { qrCode: null, qrUpdatedAt: null },
  });

  if (stale.count > 0) {
    console.log(`[recovery] reset ${stale.count} account(s) from a status left behind by the previous process`);
    await logSystemEvent("INFO", "worker", "Reset connection status left behind by the previous process", {
      accounts: stale.count,
    });
  }

  return stale.count;
}
