import { withAccountProject } from "../project/context.js";
import { countMetric } from "../health/metrics.js";
import { prisma } from "../db.js";
import type { WhatsAppProvider } from "../provider/WhatsAppProvider.js";
import { processIncomingMessage, storeMissedMessage } from "./processIncomingMessage.js";
import { logSystemEvent } from "../logging/logSystemEvent.js";

/**
 * Fills the gap in collected messages left by any period this worker was not listening.
 *
 * Live delivery is a push. Everything that arrives while the process is down, restarting, mid
 * reconnect, or between two sessions is simply never delivered — the event has been and gone, and
 * no amount of reconnect logic brings it back. Until this existed, "the worker was restarted at
 * 11:02" meant the questions asked at 11:02 were gone from this system permanently: absent from
 * the inbox, uncounted in Team Performance, invisible to "waiting for a reply", and unanswered.
 *
 * `ProcessingCheckpoint` is what makes the gap knowable. It has been written on every single
 * message since the pipeline was built and read by nothing at all — this is the reader it was
 * always for.
 *
 * Scoped to groups, which is where this product's conversations live and what `getGroups()`
 * already enumerates.
 */

/**
 * How far back a sweep will ever look, regardless of how long the gap really was.
 *
 * A worker off for a week must not wake up and drag a week of conversation through the pipeline:
 * the work is enormous, and the result is a flood of records for conversations that have long
 * since concluded. Past this line the honest position is that those messages were missed.
 */
const MAX_LOOKBACK_MS = Number(process.env.CATCHUP_MAX_LOOKBACK_HOURS || 12) * 60 * 60 * 1000;

/**
 * How recent a recovered message must be to go through the ordinary pipeline — rules, AI, a real
 * reply — rather than merely being stored.
 *
 * This is the one genuinely consequential number here. A customer who asked four minutes ago while
 * the worker restarted should still get their answer; nothing about a restart is their problem.
 * A customer who asked this morning must not receive an automated reply at lunchtime as though the
 * question had just arrived — a colleague has very likely answered in the group already, the
 * customer has moved on, and a burst of such replies on every restart is precisely the unprompted
 * bulk sending this product refuses to do.
 */
export const AUTOMATION_WINDOW_MS = Number(process.env.CATCHUP_AUTOMATION_WINDOW_MINUTES || 15) * 60 * 1000;

/**
 * Gaps shorter than this are not worth a sweep. A reconnect that takes twelve seconds has missed
 * nothing worth enumerating every active chat to find, and this runs after every connect.
 */
const MIN_GAP_MS = 60 * 1000;

/** A ceiling on one sweep, so an unexpectedly busy window cannot become an unbounded replay. */
const MAX_MESSAGES = 2000;

/**
 * The window a sweep should read, or null when there is nothing worth sweeping.
 *
 * Pure, and separated from the sweep for that reason: this and `shouldAutomateRecoveredMessage`
 * below are the two decisions here with consequences a reader can feel — one bounds how much
 * history gets dragged back in, the other decides whether a real customer gets an automated reply —
 * and both should be assertable without a database or a browser.
 */
export function resolveSweepWindow(
  lastProcessedTimestampWa: Date | null,
  now: number,
): { since: Date; gapMs: number } | null {
  if (!lastProcessedTimestampWa) return null;
  const since = new Date(Math.max(lastProcessedTimestampWa.getTime(), now - MAX_LOOKBACK_MS));
  const gapMs = now - since.getTime();
  if (gapMs < MIN_GAP_MS) return null;
  return { since, gapMs };
}

/**
 * Whether a message recovered from a gap is recent enough to answer, rather than merely record.
 *
 * See AUTOMATION_WINDOW_MS: inside the window a restart should cost the customer nothing; outside
 * it, an automated reply to a question from hours ago is worse than silence.
 */
export function shouldAutomateRecoveredMessage(timestampWa: Date, now: number): boolean {
  return timestampWa.getTime() >= now - AUTOMATION_WINDOW_MS;
}

export interface CatchUpResult {
  /** Null when there was nothing to catch up — no checkpoint yet, or too small a gap to bother. */
  gapSeconds: number | null;
  /** Messages the provider offered from inside the gap. */
  offered: number;
  /** Recent enough to go through the full pipeline, replies included. */
  automated: number;
  /** Stored for the record, deliberately not answered. */
  stored: number;
  /** Already present — the dedup guard doing its job, not an error. */
  duplicates: number;
}

/** A fresh object each time — a shared one would let any caller's edit reach the next caller. */
const nothingToDo = (): CatchUpResult => ({ gapSeconds: null, offered: 0, automated: 0, stored: 0, duplicates: 0 });

/**
 * Never throws. This runs immediately after a session comes up, and a failed sweep must leave a
 * working connection working — a gap that stays unfilled is bad; a connection torn down while
 * trying to fill it is worse.
 */
export async function catchUpMissedMessages(accountId: string, provider: WhatsAppProvider): Promise<CatchUpResult> {
  return withAccountProject(accountId, () => catchUpMissedMessagesInProject(accountId, provider));
}

async function catchUpMissedMessagesInProject(accountId: string, provider: WhatsAppProvider): Promise<CatchUpResult> {
  try {
    const checkpoint = await prisma.processingCheckpoint.findUnique({
      where: { accountId },
      select: { lastProcessedTimestampWa: true },
    });

    // No checkpoint means this account has never processed a message — a brand-new number, with no
    // gap to speak of and no history that belongs to us. Reading its whole backlog on first connect
    // would import conversations from before it was ever part of this system.
    if (!checkpoint?.lastProcessedTimestampWa) return nothingToDo();

    const now = Date.now();
    const window = resolveSweepWindow(checkpoint.lastProcessedTimestampWa, now);
    if (!window) return nothingToDo();
    const { since, gapMs } = window;

    const missed = await provider.fetchMessagesSince(since, MAX_MESSAGES);
    const result: CatchUpResult = {
      gapSeconds: Math.round(gapMs / 1000),
      offered: missed.length,
      automated: 0,
      stored: 0,
      duplicates: 0,
    };
    if (missed.length === 0) return result;

    let newest: Date | null = null;

    // Oldest first, sequentially. Order matters to anything that reads the previous message in a
    // chat, and sequential matters because the alternative is hundreds of concurrent pipeline runs
    // against the same database the live path is using.
    for (const raw of missed) {
      try {
        if (shouldAutomateRecoveredMessage(raw.timestampWa, now)) {
          await processIncomingMessage(raw);
          result.automated += 1;
          countMetric("retried");
        } else if (await storeMissedMessage(raw)) {
          result.stored += 1;
          countMetric("retried");
        } else {
          result.duplicates += 1;
        }
      } catch (err) {
        // One unparseable message must not abandon the rest of the gap.
        console.error(`[catch-up] failed to recover message ${raw.whatsappMessageId}`, err);
      }
      if (!newest || raw.timestampWa > newest) newest = raw.timestampWa;
    }

    // Advance the checkpoint so the next sweep starts where this one finished. Conditional, never
    // unconditional: live processing writes this column too, and a sweep that finishes just after a
    // fresh message landed must not wind it backwards and re-scan ground already covered.
    if (newest) {
      await prisma.processingCheckpoint.updateMany({
        where: {
          accountId,
          OR: [{ lastProcessedTimestampWa: null }, { lastProcessedTimestampWa: { lt: newest } }],
        },
        data: { lastProcessedTimestampWa: newest },
      });
    }

    console.log(`[catch-up] account ${accountId}: ${JSON.stringify(result)}`);
    // Worth a dashboard-visible record: this is the evidence that a gap existed and what was done
    // about it, which is otherwise invisible. Only when something was actually recovered — a sweep
    // that finds nothing is the normal case and does not need a log entry every reconnect.
    if (result.automated > 0 || result.stored > 0) {
      await logSystemEvent("INFO", "pipeline", "Recovered messages missed while disconnected", {
        accountId,
        ...result,
      }).catch(() => undefined);
    }

    return result;
  } catch (err) {
    console.error(`[catch-up] sweep failed for account ${accountId} — connection is unaffected`, err);
    await logSystemEvent("ERROR", "pipeline", "Could not recover messages missed while disconnected", {
      accountId,
      error: (err as Error).message,
    }).catch(() => undefined);
    return nothingToDo();
  }
}
