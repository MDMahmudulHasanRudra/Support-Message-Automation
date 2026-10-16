import { prisma } from "../db.js";
import { withAccountProject } from "../project/context.js";
import type { WhatsAppProvider } from "../provider/WhatsAppProvider.js";
import type { ProviderRegistry } from "../provider/ProviderRegistry.js";
import type { RawIncomingMessage } from "./types.js";
import { processIncomingMessage, storeMissedMessage } from "./processIncomingMessage.js";
import { shouldAutomateRecoveredMessage } from "./catchUpMissedMessages.js";
import { countMetric } from "../health/metrics.js";
import { logSystemEvent } from "../logging/logSystemEvent.js";
import { trackTick } from "../lifecycle.js";
import { recordLoopTick, registerLoop } from "../health/loopLiveness.js";

/**
 * Compares what WhatsApp Web holds for the last half hour with what is stored, and stores the
 * difference.
 *
 * The collection watchdog only asks the browser when an account has stored NOTHING for 45 minutes,
 * and the reconnect catch-up reads from the processing checkpoint forward. Both are blind to the
 * case this closes: a busy number that keeps storing most messages while a few are lost one at a
 * time (a transient database error, a message shape that threw) is neither quiet nor behind its
 * checkpoint — the missing message sits BEHIND newer ones — so nothing ever looked for it.
 *
 * It reads a fixed look-back window rather than a checkpoint, for exactly that reason, and only
 * ever ADDS: a message that is already stored is skipped (the `Message` unique key is the dedup
 * guard either way), nothing is deleted or rewritten, and an empty-body message is left alone so a
 * sticker is not re-counted as a drop every cycle.
 *
 * Whether a recovered message is answered follows the catch-up rule unchanged: inside the
 * automation window it goes through the ordinary pipeline, older ones are stored without rules.
 * Groups and one-to-one chats, like the gap sweep (the same probe); bounded by chat activity.
 */
const LOOP_NAME = "message-reconcile";
const INTERVAL_MS = () => Number(process.env.MESSAGE_RECONCILE_INTERVAL_MINUTES || 10) * 60_000;
const LOOKBACK_MS = () => Number(process.env.MESSAGE_RECONCILE_LOOKBACK_MINUTES || 30) * 60_000;
/** The most one pass will offer for one account; a bigger window is a wider problem than this fixes. */
const MAX_MESSAGES = 500;

export interface ReconcileResult {
  offered: number;
  alreadyStored: number;
  recovered: number;
  failed: number;
  /** False when the session could not be read; nothing was changed. */
  read: boolean;
}

/** The messages a pass should add: non-empty and not yet stored. Pure, so it is tested without a database. */
export function selectUnstored(offered: readonly RawIncomingMessage[], storedIds: ReadonlySet<string>): RawIncomingMessage[] {
  return offered.filter((raw) => raw.body && raw.body.trim().length > 0 && !storedIds.has(raw.whatsappMessageId));
}

export async function reconcileRecentMessages(accountId: string, provider: WhatsAppProvider, now = Date.now()): Promise<ReconcileResult> {
  return withAccountProject(accountId, () => reconcileInProject(accountId, provider, now));
}

async function reconcileInProject(accountId: string, provider: WhatsAppProvider, now: number): Promise<ReconcileResult> {
  const result: ReconcileResult = { offered: 0, alreadyStored: 0, recovered: 0, failed: 0, read: false };
  const probe = await provider.probeCollection(new Date(now - LOOKBACK_MS()), MAX_MESSAGES);
  // An unreadable session is the watchdog's finding to make, not this loop's; it changes nothing.
  if (!probe.ok) return result;
  result.read = true;
  result.offered = probe.messages.length;
  if (probe.messages.length === 0) return result;

  const stored = await prisma.message.findMany({
    where: { accountId, whatsappMessageId: { in: probe.messages.map((m) => m.whatsappMessageId) } },
    select: { whatsappMessageId: true },
  });
  const storedIds = new Set(stored.map((row) => row.whatsappMessageId));
  const missing = selectUnstored(probe.messages, storedIds);
  result.alreadyStored = probe.messages.length - missing.length;

  // Oldest first and one at a time, as the catch-up sweep does: order matters to anything that reads
  // the previous message in a chat, and the live path is using the same database.
  for (const raw of missing) {
    try {
      if (shouldAutomateRecoveredMessage(raw.timestampWa, now)) await processIncomingMessage(raw);
      else await storeMissedMessage(raw);
      result.recovered += 1;
      countMetric("retried");
    } catch (err) {
      result.failed += 1;
      console.error(`[reconcile] failed to recover message ${raw.whatsappMessageId}`, err);
    }
  }

  if (result.recovered > 0 || result.failed > 0) {
    console.warn(`[reconcile] account ${accountId}: ${JSON.stringify(result)}`);
    // WARN, not INFO: a message that was in WhatsApp's history and not in the database means the live
    // listener or the pipeline lost it, which somebody should be able to see in System Logs.
    await logSystemEvent("WARN", "pipeline", "Recovered messages the live listener did not store", {
      accountId,
      ...result,
      windowMinutes: Math.round(LOOKBACK_MS() / 60_000),
    }).catch(() => undefined);
  }
  return result;
}

/** One pass over every connected account, one at a time (each read is a call into that account's browser). */
export async function reconcileAllAccounts(registry: ProviderRegistry): Promise<void> {
  for (const accountId of registry.allAccountIds()) {
    const provider = registry.get(accountId);
    if (!provider || provider.getConnectionStatus() !== "CONNECTED") continue;
    try {
      await reconcileRecentMessages(accountId, provider);
    } catch (err) {
      // One account failing must not stop the others.
      console.error(`[reconcile] pass failed for account ${accountId}`, err);
    }
  }
}

export function startMessageReconcileProcessor(registry: ProviderRegistry, intervalMs = INTERVAL_MS()): NodeJS.Timeout {
  registerLoop(LOOP_NAME, intervalMs);
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    void trackTick(() => reconcileAllAccounts(registry))
      .catch((err) => console.error("[reconcile] pass failed", err))
      .finally(() => {
        running = false;
        recordLoopTick(LOOP_NAME, intervalMs);
      });
  }, intervalMs);
}
