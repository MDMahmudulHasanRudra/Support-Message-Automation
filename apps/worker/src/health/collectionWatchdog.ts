import { prisma } from "@support-automation/db";
import type { ProviderRegistry } from "../provider/ProviderRegistry.js";
import { catchUpMissedMessages } from "../pipeline/catchUpMissedMessages.js";
import { logSystemEvent } from "../logging/logSystemEvent.js";
import { trackTick } from "../lifecycle.js";

/**
 * Answers the question nothing else in this system could: "we look healthy, so why is nothing
 * arriving?"
 *
 * This is the failure mode with no symptom. A session reporting CONNECTED, a worker heartbeating,
 * every queue draining — and not one incoming message being stored, because the listener is wired
 * to a browser that no longer exists. That really happened (see the listener fix in
 * `OpenWAProvider`), it was total, and it was invisible, because "no messages arriving" and "a
 * quiet afternoon" are the same observation.
 *
 * The trick is not to infer anything from silence. Silence alone is not evidence — a group can be
 * quiet for six hours at night and nothing is wrong. So when an account has been quiet for a while,
 * this asks the browser what IT has seen. If WhatsApp holds messages newer than the newest one we
 * stored, the two disagree, and that disagreement is proof rather than suspicion.
 *
 * And having proved it, it fixes it: the same catch-up sweep that fills a reconnect's gap recovers
 * exactly those messages. An alarm that only tells somebody to go and look would leave the
 * customers unanswered until they did.
 */

const WATCHDOG_INTERVAL_MS = 15 * 60_000;

/**
 * How long an account must have stored nothing before it is worth asking the browser about. Long
 * enough that an ordinary lull never triggers the check, since the check costs a chat enumeration.
 */
const QUIET_THRESHOLD_MS = Number(process.env.COLLECTION_QUIET_THRESHOLD_MINUTES || 45) * 60_000;

/** Enough to prove a disagreement exists. Recovering them is the sweep's job, not this one's. */
const PROBE_LIMIT = 5;

export interface CollectionCheck {
  accountId: string;
  label: string;
  quietForMinutes: number;
  /** Messages WhatsApp holds that we never stored. Above zero means collection is broken. */
  missed: number;
}

/**
 * Checks every connected account once. Never throws — a watchdog that can take down the thing it
 * watches is worse than no watchdog.
 */
export async function checkCollectionHealth(registry: ProviderRegistry): Promise<CollectionCheck[]> {
  const findings: CollectionCheck[] = [];

  const accounts = await prisma.whatsAppAccount.findMany({
    where: { status: "CONNECTED" },
    select: { id: true, label: true },
  });

  for (const account of accounts) {
    const provider = registry.get(account.id);
    if (!provider || provider.getConnectionStatus() !== "CONNECTED") continue;

    // An account with nothing to monitor is supposed to be silent.
    const monitoredGroups = await prisma.whatsAppGroup.count({
      where: { accountId: account.id, isActive: true, isMonitored: true },
    });
    if (monitoredGroups === 0) continue;

    const newest = await prisma.message.findFirst({
      where: { accountId: account.id },
      orderBy: { timestampWa: "desc" },
      select: { timestampWa: true },
    });
    // Never stored anything at all: a number still being set up, not a number that went deaf.
    if (!newest) continue;

    const quietForMs = Date.now() - newest.timestampWa.getTime();
    if (quietForMs < QUIET_THRESHOLD_MS) continue;

    let missed = 0;
    try {
      missed = (await provider.fetchMessagesSince(newest.timestampWa, PROBE_LIMIT)).length;
    } catch (err) {
      console.warn(`[watchdog] could not probe account ${account.id} — treating as inconclusive`, err);
      continue;
    }

    const finding: CollectionCheck = {
      accountId: account.id,
      label: account.label,
      quietForMinutes: Math.round(quietForMs / 60_000),
      missed,
    };
    findings.push(finding);

    if (missed === 0) {
      // Genuinely quiet. Worth one INFO line so a long silence is on the record as CHECKED rather
      // than merely unreported — the difference matters when somebody asks later.
      console.log(`[watchdog] account "${account.label}" quiet for ${finding.quietForMinutes}m and WhatsApp agrees`);
      continue;
    }

    console.error(
      `[watchdog] account "${account.label}" reports CONNECTED but has stored nothing for ${finding.quietForMinutes}m while WhatsApp holds newer messages — collection is broken`,
    );
    await logSystemEvent("ERROR", "provider", "Connected account is not collecting messages", {
      ...finding,
      action: "running catch-up to recover them",
    }).catch(() => undefined);

    // Prove it, then fix it. The sweep dedups against what is already stored, so running it here
    // costs nothing when the disagreement turns out to be a single straggler.
    await catchUpMissedMessages(account.id, provider);
  }

  return findings;
}

export function startCollectionWatchdog(
  registry: ProviderRegistry,
  intervalMs = WATCHDOG_INTERVAL_MS,
): NodeJS.Timeout {
  let checking = false;
  return setInterval(() => {
    if (checking) return;
    checking = true;
    void trackTick(() => checkCollectionHealth(registry))
      .catch((err) => console.error("[watchdog] collection health check failed", err))
      .finally(() => {
        checking = false;
      });
  }, intervalMs);
}
