import { prisma } from "../db.js";
import { withAccountProject } from "../project/context.js";
import type { StoreMessageRef, WhatsAppProvider } from "../provider/WhatsAppProvider.js";
import type { ProviderRegistry } from "../provider/ProviderRegistry.js";
import type { RawIncomingMessage } from "./types.js";
import { processIncomingMessage, storeMissedMessage } from "./processIncomingMessage.js";
import { shouldAutomateRecoveredMessage } from "./catchUpMissedMessages.js";
import { countMetric } from "../health/metrics.js";
import { recordCollection } from "../health/collectionByKind.js";
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
  /** What the read could not check (a kind of chat, a chat, the message limit), or null. */
  incomplete: string | null;
}

/** The messages a pass should add: non-empty and not yet stored. Pure, so it is tested without a database. */
export function selectUnstored(offered: readonly RawIncomingMessage[], storedIds: ReadonlySet<string>): RawIncomingMessage[] {
  return offered.filter((raw) => raw.body && raw.body.trim().length > 0 && !storedIds.has(raw.whatsappMessageId));
}

export async function reconcileRecentMessages(accountId: string, provider: WhatsAppProvider, now = Date.now()): Promise<ReconcileResult> {
  return withAccountProject(accountId, () => reconcileInProject(accountId, provider, now));
}

async function reconcileInProject(accountId: string, provider: WhatsAppProvider, now: number): Promise<ReconcileResult> {
  const result: ReconcileResult = { offered: 0, alreadyStored: 0, recovered: 0, failed: 0, read: false, incomplete: null };
  const probe = await provider.probeCollection(new Date(now - LOOKBACK_MS()), MAX_MESSAGES);
  // An unreadable session is the watchdog's finding to make, not this loop's; it changes nothing.
  if (!probe.ok) return result;
  result.read = true;
  result.incomplete = probe.incomplete ?? null;
  if (result.incomplete) {
    // Said every pass it applies, so "the sweep ran" is never mistaken for "the sweep saw everything".
    console.warn(`[reconcile] account ${accountId}: incomplete read — ${result.incomplete}`);
  }
  result.offered = probe.messages.length;
  if (probe.messages.length === 0) return result;

  const stored = await prisma.message.findMany({
    where: { accountId, whatsappMessageId: { in: probe.messages.map((m) => m.whatsappMessageId) } },
    select: { whatsappMessageId: true },
  });
  const storedIds = new Set(stored.map((row) => row.whatsappMessageId));
  const missing = selectUnstored(probe.messages, storedIds);
  result.alreadyStored = probe.messages.length - missing.length;

  const outcome = await recoverMissing(accountId, missing, now);
  result.recovered = outcome.recovered;
  result.failed = outcome.failed;

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

/**
 * Stores messages found missing, oldest first and one at a time, as the catch-up sweep does: order
 * matters to anything that reads the previous message in a chat, and the live path is using the same
 * database. Inside the automation window a message goes through the ordinary pipeline, older ones are
 * stored without rules. Shared by the reconcile pass and the store sweep, so both treat a recovered
 * message identically.
 */
async function recoverMissing(accountId: string, missing: readonly RawIncomingMessage[], now: number): Promise<{ recovered: number; failed: number }> {
  let recovered = 0;
  let failed = 0;
  const ordered = [...missing].sort((a, b) => a.timestampWa.getTime() - b.timestampWa.getTime());
  for (const raw of ordered) {
    try {
      if (shouldAutomateRecoveredMessage(raw.timestampWa, now)) await processIncomingMessage(raw);
      else await storeMissedMessage(raw);
      recovered += 1;
      countMetric("retried");
      recordCollection(accountId, raw.chatId, "recovered");
    } catch (err) {
      failed += 1;
      console.error(`[reconcile] failed to recover message ${raw.whatsappMessageId}`, err);
    }
  }
  return { recovered, failed };
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

/*
 * ---------------------------------------------------------------------------------------------
 * The store sweep (18 Oct 2026: personal messages from unknown foreign numbers on the phone and
 * never in the database).
 *
 * The live listener, the reconnect catch-up, this file's reconcile pass and the personal backfill
 * all find a message through its CHAT: the chat list, filtered by each chat's last-activity time.
 * A chat that never shows as active (a first message from a number the phone has never talked to,
 * which WhatsApp may keep out of the ordinary chat list) hides its message from every one of them
 * at once. This reads WhatsApp Web's MESSAGE store instead: every message the page holds from the
 * look-back window, whatever chat it sits in and whether or not the new-message event fired.
 *
 * Cheap on purpose, so it can run every minute: one in-page read of ids and times, one database
 * lookup of which ids are already stored, and a full read only of the few that are not. A message
 * younger than STORE_SWEEP_MIN_AGE_MS is left to the live path that is very likely handling it
 * right now (the `Message` unique key would refuse a second copy anyway). It cannot recover a
 * message WhatsApp never delivered to this linked device; nothing on the server can.
 * ---------------------------------------------------------------------------------------------
 */
const STORE_SWEEP_LOOP = "message-store-sweep";
/** 0 turns the sweep off. */
const STORE_SWEEP_INTERVAL_MS = () => Number(process.env.MESSAGE_STORE_SWEEP_INTERVAL_SECONDS ?? 60) * 1_000;
const STORE_SWEEP_LOOKBACK_MS = () => Number(process.env.MESSAGE_STORE_SWEEP_LOOKBACK_MINUTES || 30) * 60_000;
export const STORE_SWEEP_MIN_AGE_MS = 20_000;
/** Ids read from the page per pass; the page holds far fewer in a half-hour window on any real number. */
const STORE_SWEEP_MAX_REFS = 3_000;
/** Full message reads per pass, each one call into the page. The rest wait for the next pass. */
export const STORE_SWEEP_MAX_READS = 100;
/** Ids already read and found with nothing to store (a sticker, a system line), per account, so they are not read every minute. */
const nothingToStore = new Map<string, Set<string>>();
const NOTHING_TO_STORE_CAP = 5_000;

export interface StoreSweepResult {
  /** False when the page's message store could not be read; nothing was changed. */
  read: boolean;
  held: number;
  candidates: number;
  readNow: number;
  unreadable: number;
  recovered: number;
  failed: number;
}

/**
 * Which held messages the sweep should read: not stored, not already found empty, old enough that
 * the live path has had its turn; oldest first, at most `max`. Pure, so it is tested without a
 * database or a browser.
 */
export function selectStoreSweepIds(
  refs: readonly StoreMessageRef[],
  storedIds: ReadonlySet<string>,
  skipIds: ReadonlySet<string>,
  now: number,
  minAgeMs: number,
  max: number,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const eligible = refs
    .filter((ref) => ref.t * 1000 <= now - minAgeMs && !storedIds.has(ref.id) && !skipIds.has(ref.id))
    .sort((a, b) => a.t - b.t);
  for (const ref of eligible) {
    if (seen.has(ref.id)) continue;
    seen.add(ref.id);
    out.push(ref.id);
    if (out.length >= max) break;
  }
  return out;
}

export async function sweepMessageStore(accountId: string, provider: WhatsAppProvider, now = Date.now()): Promise<StoreSweepResult> {
  return withAccountProject(accountId, () => sweepInProject(accountId, provider, now));
}

async function sweepInProject(accountId: string, provider: WhatsAppProvider, now: number): Promise<StoreSweepResult> {
  const result: StoreSweepResult = { read: false, held: 0, candidates: 0, readNow: 0, unreadable: 0, recovered: 0, failed: 0 };
  if (!provider.listStoreMessageRefs || !provider.readMessagesById) return result;
  const refs = await provider.listStoreMessageRefs(new Date(now - STORE_SWEEP_LOOKBACK_MS()), STORE_SWEEP_MAX_REFS);
  if (!refs) return result;
  result.read = true;
  result.held = refs.length;
  if (refs.length === 0) return result;

  const stored = await prisma.message.findMany({
    where: { accountId, whatsappMessageId: { in: refs.map((ref) => ref.id) } },
    select: { whatsappMessageId: true },
  });
  const storedIds = new Set(stored.map((row) => row.whatsappMessageId));
  const skip = nothingToStore.get(accountId) ?? new Set<string>();
  result.candidates = refs.filter((ref) => !storedIds.has(ref.id) && !skip.has(ref.id)).length;
  const ids = selectStoreSweepIds(refs, storedIds, skip, now, STORE_SWEEP_MIN_AGE_MS, STORE_SWEEP_MAX_READS);
  if (ids.length === 0) return result;

  result.readNow = ids.length;
  const read = await provider.readMessagesById(ids);
  result.unreadable = read.unreadable;
  const withBody = selectUnstored(read.messages, storedIds);
  // Read and empty: remembered so it is not read again every minute for the whole window.
  const keep = new Set(withBody.map((m) => m.whatsappMessageId));
  const empty = [...read.messages.filter((m) => !keep.has(m.whatsappMessageId)).map((m) => m.whatsappMessageId), ...read.unusableIds];
  if (empty.length > 0) {
    if (skip.size + empty.length > NOTHING_TO_STORE_CAP) skip.clear();
    for (const id of empty) skip.add(id);
    nothingToStore.set(accountId, skip);
  }
  const outcome = await recoverMissing(accountId, withBody, now);
  result.recovered = outcome.recovered;
  result.failed = outcome.failed;

  if (result.recovered > 0 || result.failed > 0) {
    const personal = withBody.filter((m) => !m.whatsappGroupId).length;
    console.warn(`[store-sweep] account ${accountId}: ${JSON.stringify(result)} (personal ${personal}, group ${withBody.length - personal})`);
    // WARN: a message the page held and the live listener never handed over is worth seeing in System Logs.
    await logSystemEvent("WARN", "pipeline", "Recovered messages from WhatsApp Web's message store that the live listener did not deliver", {
      accountId,
      ...result,
      personal,
      group: withBody.length - personal,
      windowMinutes: Math.round(STORE_SWEEP_LOOKBACK_MS() / 60_000),
    }).catch(() => undefined);
  }
  return result;
}

/** One pass over every connected account, one at a time (each read is a call into that account's browser). */
export async function sweepAllAccounts(registry: ProviderRegistry): Promise<void> {
  for (const accountId of registry.allAccountIds()) {
    const provider = registry.get(accountId);
    if (!provider || provider.getConnectionStatus() !== "CONNECTED") continue;
    try {
      await sweepMessageStore(accountId, provider);
    } catch (err) {
      console.error(`[store-sweep] pass failed for account ${accountId}`, err);
    }
  }
}

/** Null when switched off (MESSAGE_STORE_SWEEP_INTERVAL_SECONDS=0). */
export function startMessageStoreSweepProcessor(registry: ProviderRegistry, intervalMs = STORE_SWEEP_INTERVAL_MS()): NodeJS.Timeout | null {
  if (!(intervalMs > 0)) return null;
  registerLoop(STORE_SWEEP_LOOP, intervalMs);
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    void trackTick(() => sweepAllAccounts(registry))
      .catch((err) => console.error("[store-sweep] pass failed", err))
      .finally(() => {
        running = false;
        recordLoopTick(STORE_SWEEP_LOOP, intervalMs);
      });
  }, intervalMs);
}
