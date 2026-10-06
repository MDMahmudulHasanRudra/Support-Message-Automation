import { trackTick } from "../lifecycle.js";
import { platformPrisma, prisma } from "../db.js";
import { accountInCurrentProject, OPERATING_PROJECT_STATUSES, withAccountProject, withProject } from "../project/context.js";
import { SessionNotReadyError, type WhatsAppProvider } from "../provider/WhatsAppProvider.js";
import type { ProviderRegistry } from "../provider/ProviderRegistry.js";
import { logSystemEvent } from "../logging/logSystemEvent.js";
import { processOneGroupKnowledgeBuild } from "../knowledge/groupKnowledgeJob.js";
import { processOneAiAnalysisBatch } from "../learning/aiAnalysisJob.js";
import { runForgeKnowledgeSync } from "../forge/forgeKnowledgeJob.js";
import { buildCommunicationStyleProfile } from "../knowledge/communicationStyleJob.js";
import { catchUpMissedMessages } from "../pipeline/catchUpMissedMessages.js";
import { withTimeout } from "../util/withTimeout.js";
// From its own module, not from ProviderRegistry — that would close an import cycle, since the
// registry imports the group sync from this file.
import { connectWithRetry } from "../provider/connectWithRetry.js";
import { recordLoopTick, registerLoop } from "../health/loopLiveness.js";
import { shouldHoldDeactivationSweep } from "./groupSyncGuard.js";
import type { Prisma } from "@prisma/client";

/** Name this loop reports itself under in the per-loop liveness view. */
const LOOP_NAME = "command-processor";


/**
 * PHASE 5.2: discovers/updates the account's groups from the live provider (GROUP_SYNC.md).
 *
 * Still idempotent, which is the property that matters — safe to call repeatedly (retries, a
 * manual RESYNC_GROUPS, the post-connect passes) without ever duplicating a row or losing groups
 * synced by an earlier, since-failed attempt. `@@unique([accountId, whatsappGroupId])` remains the
 * real guarantee of that. It writes only what WhatsApp owns — the name, `isActive` and
 * `lastSyncedAt` — and never monitoring, AI, priority, exclusions or anything else a person set.
 */
export async function syncGroups(accountId: string, provider: WhatsAppProvider): Promise<number> {
  return (await syncGroupsDetailed(accountId, provider)).discovered;
}

/**
 * FULL is the ordinary sync: everything below, including the stamp and the deactivation sweep.
 * ADD_ONLY is the cheap pass run while a newly linked phone is still sending its chats: it saves
 * groups that have appeared, renames and reactivates, and touches nothing else — no stamp of every
 * row, and no sweep, which must only ever act on a complete list.
 */
export type GroupSyncMode = "FULL" | "ADD_ONLY";

export interface GroupSyncOutcome {
  discovered: number;
  created: number;
  renamed: number;
  reactivated: number;
  deactivated: number;
  /** Groups that could not be saved this pass; the next pass tries them again. */
  failed: number;
  /** The list looked incomplete, so nothing was deactivated (groupSyncGuard.ts). */
  sweepHeld: boolean;
  /** Reading the list from WhatsApp. */
  discoveryMs: number;
  /** Writing it to the database. */
  persistMs: number;
}

/**
 * Stopping a sync because its session is going away (GROUP_SYNC.md §2, "Logout and Reconnect").
 *
 * Every sync of an account carries the account's sync GENERATION from when it started. Logout and
 * Reconnect bump it (`cancelGroupSync`). A sync checks it before every write; once it has moved on,
 * the sync stops without writing anything more and without recording a state — the canceller
 * already recorded CANCELLED, and a newer sync (after the reconnect) owns the state from then on.
 *
 * Why it matters beyond the label: LOGOUT switches off every group of the account. A sync that had
 * already read the list and then reached its stamp would switch them all back on — an inbox full
 * of conversations the number can no longer reach.
 */
export class GroupSyncCancelledError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "GroupSyncCancelledError";
  }
}

const syncGeneration = new Map<string, number>();
const generationOf = (accountId: string) => syncGeneration.get(accountId) ?? 0;

/** How long a cancel waits for a sync's statement in flight to finish before Logout/Reconnect carries on. */
const CANCEL_SETTLE_WAIT_MS = 5_000;

/**
 * Stops any group sync of this account and records CANCELLED with the reason. Waits briefly for a
 * write already under way, never for the WhatsApp read (which may be what is hanging) — once the
 * generation has moved, nothing after that read can write. Safe with nothing running: returns at
 * once and records nothing.
 */
export async function cancelGroupSync(accountId: string, reason: string): Promise<boolean> {
  const running = syncInFlight.get(accountId);
  const account = running
    ? null
    : await prisma.whatsAppAccount.findFirst({ where: { id: accountId }, select: { groupSyncStatus: true } }).catch(() => null);
  syncGeneration.set(accountId, generationOf(accountId) + 1);
  if (!running && account?.groupSyncStatus !== "RUNNING") return false;

  // Released so a sync started after this (the reconnect's own) is a new one, not a join of this.
  syncInFlight.delete(accountId);
  await recordGroupSyncState(accountId, {
    groupSyncStatus: "CANCELLED",
    groupSyncStage: null,
    groupSyncCompletedAt: new Date(),
    groupSyncError: reason,
  });
  await logSystemEvent("INFO", "provider", "GROUP_SYNC_CANCELLED", { accountId, reason });
  if (running) {
    await Promise.race([running.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, CANCEL_SETTLE_WAIT_MS))]);
  }
  return true;
}

export async function syncGroupsDetailed(
  accountId: string,
  provider: WhatsAppProvider,
  mode: GroupSyncMode = "FULL",
  generation: number = generationOf(accountId),
): Promise<GroupSyncOutcome> {
  // Groups belong to the account's project, and only that project's rows are read or written.
  return withAccountProject(accountId, () => syncGroupsInProject(accountId, provider, mode, generation));
}

/**
 * Rows per `createMany`, and ids per `in` list. Postgres takes at most 65,535 bind parameters in a
 * statement, so one statement for an unbounded roster stops working somewhere in the tens of
 * thousands; bounded batches keep it working at any size, and limit what one bad row can cost.
 */
export const GROUP_SYNC_BATCH_SIZE = 500;

function inBatches<T>(items: readonly T[], size = GROUP_SYNC_BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function syncGroupsInProject(
  accountId: string,
  provider: WhatsAppProvider,
  mode: GroupSyncMode,
  generation: number,
): Promise<GroupSyncOutcome> {
  // Before every write: a Logout or Reconnect since this sync started means stop, writing nothing.
  const checkpoint = () => {
    if (generationOf(accountId) !== generation) {
      throw new GroupSyncCancelledError("The group sync was stopped because the account was logged out or reconnected.");
    }
  };
  const discoveryStarted = performance.now();
  // ONE call into the page for the whole roster — no per-group request, no participants, no
  // pictures (OpenWAProvider.listGroupChats). A chat listed twice is kept once.
  const listed = await provider.getGroups();
  checkpoint();
  const discoveryMs = Math.round(performance.now() - discoveryStarted);
  const groups = [...new Map(listed.map((group) => [group.whatsappGroupId, group])).values()];

  const persistStarted = performance.now();
  const syncedAt = new Date();

  // Everything the decisions below need, in ONE read: which groups exist, their names, and which
  // are active. From that, the inserts, renames, reactivations and the deactivation sweep are all
  // worked out in memory rather than asked of the database group by group.
  const existing = await prisma.whatsAppGroup.findMany({
    where: { accountId },
    select: { whatsappGroupId: true, name: true, isActive: true },
  });
  const known = new Map(existing.map((row) => [row.whatsappGroupId, row]));

  const fresh: typeof groups = [];
  // A rename is rare and has to be per-row, because the value differs per group. Reading the
  // current names first is what turns "1,848 updates" into "however many were actually renamed",
  // which in a steady state is none.
  const renamed: typeof groups = [];
  let reactivated = 0;
  for (const group of groups) {
    const row = known.get(group.whatsappGroupId);
    if (!row) fresh.push(group);
    else {
      if (row.name !== group.name) renamed.push(group);
      if (!row.isActive) reactivated += 1;
    }
  }

  let created = 0;
  let failed = 0;
  const failedIds = new Set<string>();
  for (const batch of inBatches(fresh)) {
    checkpoint();
    try {
      // skipDuplicates because a partially-applied earlier attempt (or a group registered by an
      // arriving message a moment ago) may already have the row — the unique constraint decides.
      const result = await prisma.whatsAppGroup.createMany({
        data: batch.map((group) => ({ accountId, whatsappGroupId: group.whatsappGroupId, name: group.name, lastSyncedAt: syncedAt })),
        skipDuplicates: true,
      });
      created += result.count;
    } catch (batchErr) {
      console.warn(`[groupsync] a batch of ${batch.length} new group(s) failed as a whole (${(batchErr as Error).message.slice(0, 200)}); saving them one at a time`);
      // One bad row fails the whole statement. Save the batch's groups one at a time so it costs
      // only itself, and count what still fails — the next pass tries those again.
      for (const group of batch) {
        try {
          const result = await prisma.whatsAppGroup.createMany({
            data: [{ accountId, whatsappGroupId: group.whatsappGroupId, name: group.name, lastSyncedAt: syncedAt }],
            skipDuplicates: true,
          });
          created += result.count;
        } catch (err) {
          failed += 1;
          failedIds.add(group.whatsappGroupId);
          console.warn(`[groupsync] could not save group ${group.whatsappGroupId}: ${(err as Error).message.slice(0, 200)}`);
        }
      }
    }
  }
  if (created > 0) console.log(`[groupsync] GROUP_SYNC_NEW ${created} group(s)`);

  for (const group of renamed) {
    checkpoint();
    try {
      await prisma.whatsAppGroup.update({
        where: { accountId_whatsappGroupId: { accountId, whatsappGroupId: group.whatsappGroupId } },
        data: { name: group.name },
      });
    } catch (err) {
      failed += 1;
      console.warn(`[groupsync] could not rename group ${group.whatsappGroupId}: ${(err as Error).message.slice(0, 200)}`);
    }
  }
  if (renamed.length > 0) console.log(`[groupsync] GROUP_SYNC_RENAMED ${renamed.length} group(s)`);

  const seenIds = groups.map((group) => group.whatsappGroupId).filter((id) => !failedIds.has(id));
  checkpoint();
  if (mode === "FULL") {
    // The stamp and the reactivation, for every group listed. `isActive: true` matters here: a
    // group the account rejoined must come back, and the sweep below is what took it away.
    for (const ids of inBatches(seenIds, 5_000)) {
      await prisma.whatsAppGroup.updateMany({
        where: { accountId, whatsappGroupId: { in: ids } },
        data: { lastSyncedAt: syncedAt, isActive: true },
      });
    }
  } else if (reactivated > 0) {
    const inactiveSeen = seenIds.filter((id) => known.get(id)?.isActive === false);
    for (const ids of inBatches(inactiveSeen, 5_000)) {
      await prisma.whatsAppGroup.updateMany({ where: { accountId, whatsappGroupId: { in: ids } }, data: { isActive: true } });
    }
  }

  // A group the account has since left/been removed from no longer appears in the list —
  // soft-deactivate it (never delete: Message.groupId history must keep a valid FK). Idempotent:
  // re-running this against the same result set is a no-op for groups already isActive: false.
  //
  // Guard: an empty `groups` result (e.g. getGroups() called while the provider's client is
  // temporarily null during a reconnect) must NEVER be treated as "the account left every
  // group" — that would mass-deactivate the entire table from a transient connection blip. Only
  // run the sweep when we actually have a real result set to compare against, and only on a FULL
  // pass: an ADD_ONLY pass runs precisely because the list is still arriving.
  let deactivated = 0;
  let sweepHeld = false;
  checkpoint();
  if (mode === "FULL" && groups.length > 0) {
    const listedIds = new Set(groups.map((group) => group.whatsappGroupId));
    // Worked out from the one read above: what is active after the reactivation, and which of
    // those WhatsApp no longer listed.
    const missing = existing.filter((row) => row.isActive && !listedIds.has(row.whatsappGroupId)).map((row) => row.whatsappGroupId);
    const wouldDeactivate = missing.length;
    const activeBefore = existing.filter((row) => row.isActive).length + reactivated + created;

    if (shouldHoldDeactivationSweep(activeBefore, wouldDeactivate)) {
      // See groupSyncGuard.ts: this read is far more likely incomplete than a real mass exit.
      sweepHeld = true;
      await logSystemEvent("WARN", "provider", "GROUP_SYNC_SWEEP_HELD", {
        accountId,
        returned: groups.length,
        activeBefore,
        wouldDeactivate,
        note: "WhatsApp returned far fewer groups than are active. Nothing was deactivated; a later sync will finish the list.",
      });
    } else if (wouldDeactivate > 0) {
      for (const ids of inBatches(missing, 5_000)) {
        checkpoint();
        // `isActive: true` in the filter too, so a group an arriving message reactivated a moment
        // ago is judged on its current state, as the counted sweep always was.
        const result = await prisma.whatsAppGroup.updateMany({
          where: { accountId, isActive: true, whatsappGroupId: { in: ids } },
          data: { isActive: false },
        });
        deactivated += result.count;
      }
      if (deactivated > 0) {
        console.log(`[groupsync] GROUP_SYNC_DEACTIVATED ${deactivated} group(s) no longer returned by the account`);
      }
    }
  }

  return {
    discovered: groups.length,
    created,
    renamed: renamed.length,
    reactivated,
    deactivated,
    failed,
    sweepHeld,
    discoveryMs,
    persistMs: Math.round(performance.now() - persistStarted),
  };
}

/**
 * The account's own sync state, for the dashboard (WhatsAppAccount.groupSync*). Best effort and
 * never throws: a failed status write must not fail the sync it describes.
 */
async function recordGroupSyncState(accountId: string, data: Prisma.WhatsAppAccountUpdateManyMutationInput): Promise<void> {
  try {
    await prisma.whatsAppAccount.updateMany({ where: { id: accountId }, data });
  } catch (err) {
    console.warn(`[groupsync] could not record the sync state for account ${accountId}: ${(err as Error).message}`);
  }
}

const GROUP_SYNC_TIMEOUT_MS = Number(process.env.WHATSAPP_GROUP_SYNC_TIMEOUT_MS) || 150_000;
// Bounded, same spirit as index.ts's CONNECT_RETRY_DELAYS_MS — not unlimited.
const GROUP_SYNC_RETRY_DELAYS_MS = [10_000, 30_000];

/**
 * PHASE 5.2 — root cause of the original crash: `getAllGroups()` on a large
 * account (~1,880 chats) hit Puppeteer's own 180s `protocolTimeout` default
 * (not something OpenWA's config exposes a way to change — confirmed by
 * reading its ConfigObject typings), and that rejection propagated all the
 * way up through index.ts's unguarded `await syncGroups(...)`, killing the
 * whole worker process — including the otherwise-healthy WhatsApp session.
 *
 * This wraps `syncGroups` with our OWN bounded timeout (fires before
 * Puppeteer's, with a clear message) plus bounded retries, and — critically —
 * never throws past its caller's control: callers decide whether a final
 * failure should surface (RESYNC_GROUPS command → FAILED, still isolated by
 * commandProcessor's own try/catch) or just be logged (initial post-connect
 * sync in index.ts, called without awaiting so it can never block message
 * processing or take the connection down with it).
 */
/**
 * Module-level, not per-call: the post-connect sync, the arrival passes and an explicit
 * RESYNC_GROUPS command are independent call sites with no shared state otherwise — without this,
 * they could genuinely run concurrently (ENGINEERING_STANDARDS.md §9's "conflicting group sync
 * operations"), and the isActive deactivation sweep is only correct against a single, complete
 * getGroups() snapshot. A second caller that arrives while one is already running gets the SAME
 * in-flight result instead of starting a competing sync.
 *
 * In memory rather than in the database, deliberately: only the process holding an account's
 * browser can sync it, and there is one such process — a database lock would guard against a
 * second worker that cannot exist without also fighting over the WhatsApp session itself.
 *
 * Keyed by accountId, because the conflict this guards against is per-session: two accounts sync
 * different providers and write disjoint rows. A single shared slot meant the second account
 * connecting during startup was handed the FIRST account's promise, so its own getGroups() never
 * ran — it ended up with zero groups while the log reported the other account's count.
 */
const syncInFlight = new Map<string, Promise<number>>();

/** Whether this account has a group sync running in this process right now. */
export function isGroupSyncRunning(accountId: string): boolean {
  return syncInFlight.has(accountId);
}

export async function syncGroupsWithTimeoutAndRetry(
  accountId: string,
  provider: WhatsAppProvider,
): Promise<number> {
  const alreadyRunning = syncInFlight.get(accountId);
  if (alreadyRunning) {
    console.log(
      `[groupsync] GROUP_SYNC_ALREADY_IN_PROGRESS accountId=${accountId} -- reusing the in-flight sync instead of starting a second one`,
    );
    return alreadyRunning;
  }

  const run = withAccountProject(accountId, () => runSyncWithRetry(accountId, provider));
  syncInFlight.set(accountId, run);
  try {
    return await run;
  } finally {
    // Only our own entry: a cancel may already have released it for a newer sync.
    if (syncInFlight.get(accountId) === run) syncInFlight.delete(accountId);
  }
}

async function runSyncWithRetry(accountId: string, provider: WhatsAppProvider): Promise<number> {
  const attempts = GROUP_SYNC_RETRY_DELAYS_MS.length + 1;
  const started = performance.now();
  const generation = generationOf(accountId);
  // A state write from a sync that has since been cancelled would overwrite CANCELLED, or the
  // state of the newer sync that replaced it.
  const record = async (data: Prisma.WhatsAppAccountUpdateManyMutationInput) => {
    if (generationOf(accountId) === generation) await recordGroupSyncState(accountId, data);
  };
  await logSystemEvent("INFO", "provider", "GROUP_SYNC_STARTED", { accountId });
  await record({
    groupSyncStatus: "RUNNING",
    groupSyncStage: "Reading the group list from WhatsApp",
    groupSyncStartedAt: new Date(),
    groupSyncError: null,
  });

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const outcome = await withTimeout(syncGroupsDetailed(accountId, provider, "FULL", generation), GROUP_SYNC_TIMEOUT_MS, "group sync");
      const totalMs = Math.round(performance.now() - started);
      await logSystemEvent("INFO", "provider", "GROUP_SYNC_COMPLETED", {
        accountId,
        groupCount: outcome.discovered,
        attempt,
        created: outcome.created,
        renamed: outcome.renamed,
        reactivated: outcome.reactivated,
        deactivated: outcome.deactivated,
        failed: outcome.failed,
        sweepHeld: outcome.sweepHeld,
        discoveryMs: outcome.discoveryMs,
        persistMs: outcome.persistMs,
        totalMs,
      });
      await record({
        groupSyncStatus: outcome.failed > 0 || outcome.sweepHeld ? "PARTIAL" : "COMPLETED",
        groupSyncStage: null,
        groupSyncCompletedAt: new Date(),
        groupSyncDiscovered: outcome.discovered,
        groupSyncNew: outcome.created,
        groupSyncUpdated: outcome.renamed + outcome.reactivated,
        groupSyncDeactivated: outcome.deactivated,
        groupSyncFailed: outcome.failed,
        groupSyncDurationMs: totalMs,
        groupSyncError:
          outcome.failed > 0
            ? `${outcome.failed} group(s) could not be saved; the next sync tries them again.`
            : outcome.sweepHeld
              ? "WhatsApp listed far fewer groups than are active, so none were switched off. The next sync completes the list."
              : null,
      });
      return outcome.discovered;
    } catch (err) {
      // Stopped by a Logout or Reconnect: not a failure, never retried, and the canceller has
      // already recorded CANCELLED with its reason.
      if (err instanceof GroupSyncCancelledError || generationOf(accountId) !== generation) {
        throw err instanceof GroupSyncCancelledError ? err : new GroupSyncCancelledError("The group sync was stopped because the account was logged out or reconnected.");
      }
      const message = (err as Error).message ?? String(err);
      const isTimeout = message.includes("timed out");
      // A logged-out or disconnected session will be exactly as logged out in ten seconds, so this
      // is the last attempt whatever the counter says. Retrying it produced two more identical
      // failures and forty seconds of the operator waiting on an answer that was already known.
      const isLastAttempt = attempt === attempts || err instanceof SessionNotReadyError;
      await logSystemEvent(
        isLastAttempt ? "ERROR" : "WARN",
        "provider",
        isTimeout ? "GROUP_SYNC_TIMEOUT" : "GROUP_SYNC_FAILED",
        { attempt, attempts, error: message },
      );
      if (isLastAttempt) {
        await record({
          groupSyncStatus: "FAILED",
          groupSyncStage: null,
          groupSyncCompletedAt: new Date(),
          groupSyncDurationMs: Math.round(performance.now() - started),
          groupSyncError: message.slice(0, 500),
        });
        throw err;
      }
      const delayMs = GROUP_SYNC_RETRY_DELAYS_MS[attempt - 1];
      await logSystemEvent("INFO", "provider", "GROUP_SYNC_RETRY", { nextAttempt: attempt + 1, delayMs });
      await record({ groupSyncStage: `Retrying in ${Math.round(delayMs! / 1000)}s (attempt ${attempt + 1} of ${attempts})` });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (generationOf(accountId) !== generation) {
        throw new GroupSyncCancelledError("The group sync was stopped because the account was logged out or reconnected.");
      }
    }
  }
  // Unreachable: the loop above always either returns or throws on the last attempt.
  throw new Error("syncGroupsWithTimeoutAndRetry: exhausted attempts without resolving");
}

/**
 * Everything that has to happen once a session is live again, wherever the connect came from.
 *
 * THIS EXISTS BECAUSE ONLY ONE OF THE THREE CONNECT PATHS DID IT. `ProviderRegistry.connectAccount()`
 * chained a group sync and a catch-up sweep; the RECONNECT command and `recoverIfDropped()` both
 * connected and stopped. So an account linked from the dashboard button — which, since Connect
 * began issuing RECONNECT directly, is the normal way anybody links one — came up CONNECTED with
 * whatever group rows it happened to already have. On a number that had just been logged out that
 * is every group marked `isActive: false` by the LOGOUT handler, and on a fresh account it is none
 * at all. The dashboard reported a healthy session with an empty or dead group list, and nothing
 * anywhere said why. Observed in production on 23 Sep 2026, immediately after a deploy and a
 * successful QR scan.
 *
 * The interaction that made it likely rather than rare: pressing Connect issues RECONNECT, whose
 * first act is `provider.disconnect()`. If the registry's own `connectAccount()` was still waiting
 * for a scan at that moment, that abandons it — taking its chained sync with it — and hands the
 * link to the one path that does not sync.
 *
 * NOT AWAITED, exactly as the registry always had it. A sync is three attempts at up to 150s plus
 * backoff, roughly eight minutes at worst, and the command processor is strictly serial: awaiting
 * this would hold Show QR, Logout and every other account's commands behind it. The operator's
 * question at that moment is "did it connect", which is answered either way.
 *
 * Catch-up runs AFTER the sync rather than beside it, which is the ordering the registry chose and
 * documented: a message recovered from a group that is not in the database yet files under no
 * group at all.
 *
 * Safe to call from all three paths at once — `syncGroupsWithTimeoutAndRetry` joins an in-flight
 * sync for the same account rather than starting a second.
 */
export function resyncAndCatchUpAfterConnect(
  accountId: string,
  provider: WhatsAppProvider,
  source: string,
): void {
  // The whole chain — sync, catch-up and the arrival passes it starts — runs as the account's
  // project, so its log lines and rows are attributed there.
  void withAccountProject(accountId, async () => resyncAndCatchUpInProject(accountId, provider, source)).catch((err) => {
    console.error(`[worker] could not start the post-connect sync for account ${accountId}`, err);
  });
}

function resyncAndCatchUpInProject(accountId: string, provider: WhatsAppProvider, source: string): Promise<unknown> {
  // The passes that follow belong to this connect: a Logout or Reconnect after it stops them.
  const generation = generationOf(accountId);
  const connectedAt = Date.now();
  let firstCount: number | null = null;
  return syncGroupsWithTimeoutAndRetry(accountId, provider)
    .then((groupCount) => {
      firstCount = groupCount;
      console.log(`[worker] synced ${groupCount} group(s) for account ${accountId} after ${source}`);
    })
    .catch((err) => {
      if (err instanceof GroupSyncCancelledError) {
        console.log(`[worker] group sync for account ${accountId} after ${source} was stopped: ${err.message}`);
        return;
      }
      console.error(
        `[worker] group sync failed after retries for account ${accountId} after ${source} — the session stays connected, but its group list is now stale. Press Resync Groups.`,
        err,
      );
      return logSystemEvent("ERROR", "provider", "Group sync failed after connecting", {
        accountId,
        source,
        error: (err as Error).message,
      }).catch(() => undefined);
    })
    .then(() => catchUpMissedMessages(accountId, provider))
    .catch((err) => {
      console.error(`[worker] catch-up failed for account ${accountId} after ${source}`, err);
    })
    .finally(() => watchGroupListArrival(accountId, provider, source, generation, connectedAt, firstCount));
}

/**
 * How the group list is read while a phone is still sending it, and when that is judged done.
 *
 * A number that has just been linked receives its chats from the phone over several minutes, and
 * the first sync runs the moment the session comes up — so it reads whatever has arrived by then
 * (on 24 Sep 2026: 498 of 1,952 groups). The rest used to appear only at the fixed passes 5 and 15
 * minutes later. Now the list is read again every `intervalMs` — one call into the page, writing
 * only what is new — so a group appears within one interval of WhatsApp delivering it, and the
 * reading stops once `stableReads` passes in a row show no growth (no new group and no bigger
 * list than any seen since the connect — `isGrowthPass`), then one FULL sync, which is what may
 * switch off groups the account left. A long-linked number whose list is already
 * complete settles on its first few passes and costs a handful of cheap reads.
 */
export const GROUP_ARRIVAL_SETTINGS = {
  intervalMs: Number(process.env.WHATSAPP_GROUP_ARRIVAL_INTERVAL_MS) || 30_000,
  stableReads: 3,
  maxMs: 20 * 60_000,
};

/**
 * Whether a pass shows the list is still arriving. Two independent signals, either one is growth:
 *
 * - **new groups** (`created + reactivated`): rows this account did not have;
 * - **a bigger list than ever seen** (`returned` above `maxReturned`, the largest list WhatsApp
 *   has returned since this connect).
 *
 * The second is what an account with existing rows needs. Its groups are already in the database,
 * so a list growing 492 → 900 → 1,400 creates nothing and "new groups" alone reads as stable after
 * three passes while the list is still filling. A SMALLER list is not growth and not stability
 * evidence of anything either: it neither moves `maxReturned` nor permits any deactivation — the
 * sweep and its guard (`groupSyncGuard.ts`) are untouched and still decide that alone.
 */
export function isGrowthPass(arrived: number, returned: number, maxReturned: number): boolean {
  return arrived > 0 || returned > maxReturned;
}

/**
 * Whether to keep reading: settled after `stableReads` passes in a row that showed no growth
 * (`growthPerPass`, from `isGrowthPass`).
 */
export function groupArrivalDecision(
  growthPerPass: readonly boolean[],
  elapsedMs: number,
  settings: { stableReads: number; maxMs: number } = GROUP_ARRIVAL_SETTINGS,
): "CONTINUE" | "SETTLED" | "GAVE_UP" {
  const tail = growthPerPass.slice(-settings.stableReads);
  if (tail.length === settings.stableReads && tail.every((grew) => !grew)) return "SETTLED";
  if (elapsedMs >= settings.maxMs) return "GAVE_UP";
  return "CONTINUE";
}

/**
 * The arrival passes after a connect, then one last FULL sync 15 minutes after it (the old
 * safety net, kept for a phone that pauses). Each pass skips while another sync of this account is
 * running, and everything stops if the session drops. Timers are `unref`ed so a pending pass never
 * holds the process open at shutdown.
 */
const FINAL_FULL_SYNC_AFTER_MS = 15 * 60_000;

function watchGroupListArrival(
  accountId: string,
  provider: WhatsAppProvider,
  source: string,
  generation: number,
  connectedAt: number,
  firstCount: number | null,
): void {
  const started = Date.now();
  const growthPerPass: boolean[] = [];
  // The largest list WhatsApp has returned since this connect; the first sync's count is the baseline.
  let maxReturned = firstCount ?? 0;
  // When each group arrived, as seconds since the connect — the production measurement of how long
  // WhatsApp takes to hand a new device its list. Recorded once, in System Logs, when it settles.
  const timeline: Array<{ atSeconds: number; total: number; new: number }> =
    firstCount === null ? [] : [{ atSeconds: Math.round((Date.now() - connectedAt) / 1000), total: firstCount, new: firstCount }];
  const cancelled = () => generationOf(accountId) !== generation;

  const schedule = (fn: () => void, delayMs: number) => {
    const timer = setTimeout(fn, delayMs);
    timer.unref?.();
  };

  const fullSync = (label: string) => {
    if (cancelled() || provider.getConnectionStatus() !== "CONNECTED") return;
    syncGroupsWithTimeoutAndRetry(accountId, provider)
      .then((groupCount) => console.log(`[worker] ${label} after ${source}: ${groupCount} group(s) for account ${accountId}`))
      .catch((err) => console.error(`[worker] ${label} failed for account ${accountId}`, err));
  };

  // Set once a pass has reported "still receiving", so a session that drops before the list
  // settles does not leave the card saying "syncing" forever.
  let markedRunning = false;
  const stopBecauseDisconnected = () => {
    if (!markedRunning) return;
    void withAccountProject(accountId, () =>
      recordGroupSyncState(accountId, {
        groupSyncStatus: "PARTIAL",
        groupSyncStage: null,
        groupSyncCompletedAt: new Date(),
        groupSyncError: "The session disconnected while the phone was still sending chats. The groups received so far are saved; the rest arrive after reconnecting.",
      }),
    ).catch(() => undefined);
  };

  const logTimeline = (outcome: "SETTLED" | "GAVE_UP") =>
    withAccountProject(accountId, () =>
      logSystemEvent("INFO", "provider", "GROUP_ARRIVAL_SETTLED", {
        accountId,
        source,
        outcome,
        passes: growthPerPass.length,
        totalSeconds: Math.round((Date.now() - connectedAt) / 1000),
        timeline,
      }),
    ).catch(() => undefined);

  const pass = () => {
    if (cancelled()) return; // Logout or Reconnect: its own flow owns the account now
    if (provider.getConnectionStatus() !== "CONNECTED") return stopBecauseDisconnected();
    if (isGroupSyncRunning(accountId)) {
      schedule(pass, GROUP_ARRIVAL_SETTINGS.intervalMs); // a resync is reading it already
      return;
    }
    const run = withAccountProject(accountId, () => syncGroupsInProject(accountId, provider, "ADD_ONLY", generation));
    // Registered like any sync, so a manual resync arriving now joins this pass instead of racing it.
    const tracked = run.then((outcome) => outcome.discovered);
    tracked.catch(() => undefined);
    syncInFlight.set(accountId, tracked);
    void run
      .then(async (outcome) => {
        if (cancelled()) return; // stopped between this pass's last write and here
        // Released before deciding, so the FULL sync started below is a sync of its own rather
        // than joining this ADD_ONLY pass (which would skip the stamp, the sweep and the status).
        if (syncInFlight.get(accountId) === tracked) syncInFlight.delete(accountId);
        const arrived = outcome.created + outcome.reactivated;
        const grew = isGrowthPass(arrived, outcome.discovered, maxReturned);
        growthPerPass.push(grew);
        maxReturned = Math.max(maxReturned, outcome.discovered);
        if (grew) timeline.push({ atSeconds: Math.round((Date.now() - connectedAt) / 1000), total: outcome.discovered, new: arrived });
        if (grew) {
          console.log(`[groupsync] GROUP_ARRIVAL ${arrived} new group(s) for account ${accountId}, ${outcome.discovered} listed so far`);
          markedRunning = true;
          await withAccountProject(accountId, () =>
            recordGroupSyncState(accountId, {
              groupSyncStatus: "RUNNING",
              groupSyncStage: `Receiving chats from the phone — ${outcome.discovered.toLocaleString("en-US")} groups so far`,
              groupSyncDiscovered: outcome.discovered,
            }),
          );
        }
        const decision = groupArrivalDecision(growthPerPass, Date.now() - started);
        if (decision === "CONTINUE") schedule(pass, GROUP_ARRIVAL_SETTINGS.intervalMs);
        else {
          void logTimeline(decision);
          fullSync(decision === "SETTLED" ? "group list settled; full sync" : "group arrival window ended; full sync");
        }
      })
      .catch((err) => {
        if (err instanceof GroupSyncCancelledError) return;
        console.error(`[groupsync] arrival pass failed for account ${accountId}`, err);
        if (Date.now() - started < GROUP_ARRIVAL_SETTINGS.maxMs) schedule(pass, GROUP_ARRIVAL_SETTINGS.intervalMs);
      })
      .finally(() => {
        if (syncInFlight.get(accountId) === tracked) syncInFlight.delete(accountId);
      });
  };

  schedule(pass, GROUP_ARRIVAL_SETTINGS.intervalMs);
  schedule(() => fullSync("15-minute follow-up sync"), FINAL_FULL_SYNC_AFTER_MS);
}

/**
 * The longest a command can legitimately still be running.
 *
 * Set by the slowest one there is: RECONNECT calls `provider.connect()`, which waits up to ten
 * minutes for a QR scan, and then runs a catch-up sweep. RESYNC_GROUPS is next at 150s per attempt
 * plus two retries. Twenty minutes is comfortably past both, which is the direction to err in —
 * releasing a command too early tells an operator a lie and invites them to run a second one on
 * top of the first, while releasing it late costs one more five-minute sweep.
 */
const COMMAND_STUCK_TIMEOUT_MS = Number(process.env.COMMAND_STUCK_TIMEOUT_MINUTES || 20) * 60_000;

/**
 * Crash recovery for commands interrupted mid-flight. Until this existed a PROCESSING row was
 * never reclaimed, so the dashboard button spun forever with no error.
 *
 * **`atBoot` is the whole safety of this function, and its absence was a real bug.** At boot
 * nothing can legitimately be in flight — this process has just started and `startCommandProcessor`
 * does not exist yet — so every PROCESSING row is orphaned by definition and no cutoff is needed.
 * That was the original justification, written into the comment here, and it was true.
 *
 * Then this started running every five minutes as well, and the justification silently stopped
 * holding. On a live worker it began marking commands FAILED WHILE THEY WERE STILL RUNNING: a
 * RECONNECT waiting for somebody to scan a QR, an eight-minute group resync — each told the
 * operator "the worker restarted while this was running, run it again", so they ran a second one
 * on top of the first. `recovery.ts` even asserts in its own comment that every recovery only
 * touches rows past its own threshold; this was the one that did not.
 *
 * A row with a null `startedAt` predates that column, so it was claimed by a process that is now
 * gone — released at boot, never by the periodic sweep, which cannot know that.
 *
 * FAILED rather than back to PENDING: re-running is harmless for RECONNECT, but not for
 * every type — a re-run SEND_LIVE_TEST would put a second real message into a chat, and a re-run
 * LOGOUT would tear down a session that may have come up healthy since. Silently repeating a
 * side-effectful command is not the house default, so the operator gets an actionable reason and
 * one click to retry instead.
 */
export async function recoverStuckCommands(options: { atBoot?: boolean } = {}): Promise<number> {
  // Install-wide on purpose: this worker process's own stranded claims, whichever project queued them.
  const result = await platformPrisma.workerCommand.updateMany({
    where: options.atBoot
      ? { status: "PROCESSING" }
      : { status: "PROCESSING", startedAt: { lt: new Date(Date.now() - COMMAND_STUCK_TIMEOUT_MS) } },
    data: {
      status: "FAILED",
      processedAt: new Date(),
      result: {
        error: options.atBoot
          ? "The worker restarted while this command was running, so it did not finish. Run it again."
          : "This command ran for far longer than it should have and was stopped. Run it again.",
      },
    },
  });
  return result.count;
}

async function claimNextCommand() {
  // One shared queue, strictly serial, in one global order; each command then runs inside the
  // project that queued it (withProject(command.projectId)).
  const candidate = await platformPrisma.workerCommand.findFirst({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
  });
  if (!candidate) return null;

  const claim = await platformPrisma.workerCommand.updateMany({
    where: { id: candidate.id, status: "PENDING" },
    // Stamped in the same write that claims the row, so a command is never PROCESSING without a
    // time to age it from. This is what lets the periodic sweep leave live work alone.
    data: { status: "PROCESSING", startedAt: new Date() },
  });
  if (claim.count === 0) return null;

  return platformPrisma.workerCommand.findUniqueOrThrow({ where: { id: candidate.id } });
}

/**
 * Dashboard → worker actions that need the live browser session (QR fetch,
 * reconnect, group resync, an explicit live test send) travel through this
 * DB-mediated channel — never a direct HTTP call (see ARCHITECTURE.md).
 *
 * Kept exactly as it was pre-multi-account (accountId/provider passed in directly, not resolved
 * from a registry) so every existing test keeps working unchanged against a single account +
 * MockProvider. `processOneCommandViaRegistry` below is the new multi-account entry point that
 * resolves accountId/provider from the claimed command and this same function otherwise.
 */
/** Exported for direct testing — drains exactly one due command, or returns false if none are pending. */
export async function processOneCommand(accountId: string, provider: WhatsAppProvider): Promise<boolean> {
  const command = await claimNextCommand();
  if (!command) return false;
  if (await refuseForHeldProject(command)) return true;
  await withProject(command.projectId, () => runClaimedCommandWithProvider(command, accountId, provider));
  return true;
}

async function runClaimedCommandWithProvider(command: ClaimedCommand, accountId: string, provider: WhatsAppProvider): Promise<boolean> {
  if (command.type === "AI_ANALYSIS_BATCH") {
    await executeAiAnalysisBatchCommand(command);
    return true;
  }
  if (command.type === "TEAMS_SYNC_NOW") {
    await closeRetiredTeamsCommand(command);
    return true;
  }
  if (command.type === "BUILD_GROUP_KNOWLEDGE") {
    await executeBuildGroupKnowledgeCommand(command);
    return true;
  }
  if (!(await refuseForeignAccount(command, accountId))) return true;
  await executeClaimedCommand(command, accountId, provider);
  return true;
}

/**
 * What a command may still do once its project is no longer operating (audit MEDIUM #4). The
 * dashboard cannot queue anything for a suspended or archived project (it is read-only there), but
 * a command queued BEFORE the change used to run regardless — a live test send, a group join, an AI
 * job, all outward or background work the suspension exists to stop.
 *
 *   SUSPENDED  keeps the session itself healthy and readable — collection is a push and continues in
 *              every status (§8) — so session upkeep and read-only lookups still run.
 *   ARCHIVED   its accounts are not connected at all, so only ending a session still means anything.
 *
 * Everything else is closed as FAILED with the reason, never left PENDING: the queue is one global
 * oldest-first line, and a row that is skipped but kept would be found again on every tick, ahead
 * of every other project's commands.
 */
const ALLOWED_WHEN_HELD: Record<string, readonly string[]> = {
  SUSPENDED: ["RECONNECT", "LOGOUT", "RESYNC_GROUPS", "GET_GROUP_PARTICIPANT_COUNT", "GET_GROUP_PARTICIPANTS"],
  ARCHIVED: ["LOGOUT"],
};

/** Closes a claimed command its project's status no longer permits. True when it was refused. */
async function refuseForHeldProject(command: ClaimedCommand): Promise<boolean> {
  const project = await platformPrisma.project.findUnique({ where: { id: command.projectId }, select: { status: true } });
  const status = project?.status ?? "ARCHIVED";
  if ((OPERATING_PROJECT_STATUSES as readonly string[]).includes(status)) return false;
  if ((ALLOWED_WHEN_HELD[status] ?? []).includes(command.type)) return false;
  await platformPrisma.workerCommand.update({
    where: { id: command.id },
    data: {
      status: "FAILED",
      processedAt: new Date(),
      result: { error: `The project is ${status.toLowerCase()}, so this command was not run. Reactivate the project and run it again.` },
    },
  });
  // Attributed to the command's own project, so it shows on that project's System Logs page.
  await withProject(command.projectId, () =>
    logSystemEvent("WARN", "worker", "Closed a command queued before its project stopped operating", {
      commandId: command.id,
      type: command.type,
      projectStatus: status,
    }),
  ).catch(() => undefined);
  return true;
}

/**
 * A command acts on a WhatsApp account, and that account must belong to the project that queued
 * the command (MULTI_PROJECT_PLAN.md Phase 3). Returns false after failing and logging the command
 * otherwise — a RECONNECT, LOGOUT or live test send is never run against another project's number.
 */
async function refuseForeignAccount(command: ClaimedCommand, accountId: string): Promise<boolean> {
  if (await accountInCurrentProject(accountId)) return true;
  await prisma.workerCommand.update({
    where: { id: command.id },
    data: {
      status: "FAILED",
      processedAt: new Date(),
      result: { error: "This command names a WhatsApp account outside its project, so it was not run." },
    },
  });
  await logSystemEvent("ERROR", "worker", "Refused a command against an account outside its project", {
    commandId: command.id,
    type: command.type,
    accountId,
    commandProjectId: command.projectId,
  }).catch(() => undefined);
  return false;
}

/**
 * Multi-account entry point: claims exactly once (never delegates to `processOneCommand`, which
 * would claim a second time and find nothing — the row is already PROCESSING by then), resolves
 * which account/provider to run against from the claimed command's own `accountId`, then shares
 * the exact same per-type handling via `executeClaimedCommand`.
 */
export async function processOneCommandViaRegistry(registry: ProviderRegistry): Promise<boolean> {
  const command = await claimNextCommand();
  if (!command) return false;
  if (await refuseForHeldProject(command)) return true;
  await withProject(command.projectId, () => runClaimedCommandViaRegistry(command, registry));
  return true;
}

async function runClaimedCommandViaRegistry(command: ClaimedCommand, registry: ProviderRegistry): Promise<boolean> {

  // Account-agnostic: scans PatternCandidate rows globally, needs no WhatsApp session at all —
  // must be handled before the accountId-required check just below.
  if (command.type === "AI_ANALYSIS_BATCH") {
    await executeAiAnalysisBatchCommand(command);
    return true;
  }

  // Retired with the Microsoft Teams Integration module. Only an old queued row can still carry
  // it, and it carries no account — so it is closed here, before the account check below would fail
  // it with a message about a missing account that has nothing to do with the real reason.
  if (command.type === "TEAMS_SYNC_NOW") {
    await closeRetiredTeamsCommand(command);
    return true;
  }

  // Reads the Message table only — no WhatsApp session, so it must also be handled before the
  // accountId-required check below.
  if (command.type === "BUILD_GROUP_KNOWLEDGE") {
    await executeBuildGroupKnowledgeCommand(command);
    return true;
  }

  // Talks to Forge and the knowledge base only — no WhatsApp session either.
  if (command.type === "FORGE_SYNC_NOW") {
    await executeForgeSyncNowCommand(command);
    return true;
  }

  // Reads stored messages and writes one settings row — no WhatsApp session either.
  if (command.type === "BUILD_COMMUNICATION_STYLE") {
    await executeBuildCommunicationStyleCommand(command);
    return true;
  }

  if (!command.accountId) {
    await prisma.workerCommand.update({
      where: { id: command.id },
      data: { status: "FAILED", processedAt: new Date(), result: { error: "Command has no accountId (created before multi-account support?)." } },
    });
    return true;
  }

  if (!(await refuseForeignAccount(command, command.accountId))) return true;

  const provider = registry.get(command.accountId);
  if (!provider) {
    await prisma.workerCommand.update({
      where: { id: command.id },
      data: { status: "FAILED", processedAt: new Date(), result: { error: `Account ${command.accountId} is not connected in this worker.` } },
    });
    return true;
  }

  await executeClaimedCommand(command, command.accountId, provider);
  return true;
}

type ClaimedCommand = NonNullable<Awaited<ReturnType<typeof claimNextCommand>>>;

/** The dashboard's "Run AI analysis now" button — runs immediately instead of waiting for aiAnalysisProcessor.ts's own long scheduled interval. Never touches a WhatsApp provider/account. */
async function executeAiAnalysisBatchCommand(command: ClaimedCommand): Promise<void> {
  try {
    const didWork = await processOneAiAnalysisBatch("MANUAL");
    await prisma.workerCommand.update({
      where: { id: command.id },
      data: { status: "DONE", processedAt: new Date(), result: { didWork } },
    });
  } catch (err) {
    await prisma.workerCommand.update({
      where: { id: command.id },
      data: { status: "FAILED", processedAt: new Date(), result: { error: (err as Error).message } },
    });
  }
}

/**
 * The dashboard's "Build knowledge now" button — reads one group's stored conversation and
 * distils it immediately, rather than waiting for its turn in the hourly rotation. Never touches
 * a WhatsApp provider/account.
 */
async function executeBuildGroupKnowledgeCommand(command: ClaimedCommand): Promise<void> {
  try {
    const payload = (command.payload ?? {}) as { groupId?: string };
    if (!payload.groupId) {
      await prisma.workerCommand.update({
        where: { id: command.id },
        data: { status: "FAILED", processedAt: new Date(), result: { error: "No groupId in payload." } },
      });
      return;
    }
    const result = await processOneGroupKnowledgeBuild(undefined, payload.groupId);
    await prisma.workerCommand.update({
      where: { id: command.id },
      data: { status: "DONE", processedAt: new Date(), result: { ...result } },
    });
  } catch (err) {
    await prisma.workerCommand.update({
      where: { id: command.id },
      data: { status: "FAILED", processedAt: new Date(), result: { error: (err as Error).message } },
    });
  }
}

/** Closes a queued Teams sync left over from before the Microsoft Teams Integration was removed. */
async function closeRetiredTeamsCommand(command: ClaimedCommand): Promise<void> {
  await prisma.workerCommand.update({
    where: { id: command.id },
    data: {
      status: "FAILED",
      processedAt: new Date(),
      result: { error: "Microsoft Teams Integration has been removed from Softify Assist." },
    },
  });
}

/**
 * A full repository re-read can take a couple of minutes across dozens of model calls, which is
 * far longer than any other command here. It still runs inline: the command processor is strictly
 * serial by design, and the alternative — a detached promise — would let a second Sync now start
 * on top of the first.
 */
async function executeForgeSyncNowCommand(command: ClaimedCommand): Promise<void> {
  try {
    const result = await runForgeKnowledgeSync();
    await prisma.workerCommand.update({
      where: { id: command.id },
      data: { status: "DONE", processedAt: new Date(), result: { ...result } },
    });
  } catch (err) {
    await prisma.workerCommand.update({
      where: { id: command.id },
      data: { status: "FAILED", processedAt: new Date(), result: { error: (err as Error).message } },
    });
  }
}

async function executeBuildCommunicationStyleCommand(command: ClaimedCommand): Promise<void> {
  try {
    const result = await buildCommunicationStyleProfile();
    await prisma.workerCommand.update({
      where: { id: command.id },
      data: { status: "DONE", processedAt: new Date(), result: { ...result } },
    });
  } catch (err) {
    await prisma.workerCommand.update({
      where: { id: command.id },
      data: { status: "FAILED", processedAt: new Date(), result: { error: (err as Error).message } },
    });
  }
}

async function executeClaimedCommand(command: ClaimedCommand, accountId: string, provider: WhatsAppProvider): Promise<void> {
  try {
    switch (command.type) {
      case "RECONNECT": {
        // ENGINEERING_STANDARDS.md §9: "a command that is already running should not be started
        // again unnecessarily" -- a queued RECONNECT that only reaches the front of the queue
        // after the account has since reconnected on its own (e.g. via session persistence) must
        // not blindly tear down an already-healthy session. This is the exact real incident that
        // motivated this guard (two stale RECONNECT commands fired back-to-back into a session
        // that had just connected, the second one broke the browser into an unresponsive state).
        if (provider.getConnectionStatus() === "CONNECTED") {
          await prisma.workerCommand.update({
            where: { id: command.id },
            data: {
              status: "DONE",
              processedAt: new Date(),
              result: { reconnected: false, reason: "Already connected -- reconnect skipped as unnecessary." },
            },
          });
          break;
        }
        // A sync of the session being torn down stops first, as CANCELLED rather than as a failure.
        // The reconnect's own post-connect sync starts afresh.
        await cancelGroupSync(accountId, "Stopped for a reconnect. A new sync starts once the account is connected again.");
        await provider.disconnect();
        /**
         * Retried, exactly like the automatic path — and it was not, which is why linking so often
         * needed several presses.
         *
         * `accountRegistrySync` has always gone through `connectWithRetry`: three attempts with
         * backoff, so a first attempt that never reaches WhatsApp's linking screen is followed by
         * another on its own. The button an operator actually presses called `provider.connect()`
         * once. One miss and there was no second try — the command simply failed, the account went
         * ERROR, and the only thing that could produce a code again was a person pressing Connect
         * again. Two paths to the same operation, one of them giving up instantly.
         *
         * This only ever retries a connect that produced NOTHING. Once a code is on screen the
         * attempt is waiting on a human, the short no-code deadline is cancelled, and the generous
         * scan watchdog takes over — so retrying here can never cut somebody's scan short.
         */
        const reconnected = await connectWithRetry(provider, accountId);
        if (!reconnected) {
          await prisma.workerCommand.update({
            where: { id: command.id },
            data: {
              status: "FAILED",
              processedAt: new Date(),
              result: {
                error:
                  "WhatsApp did not produce a code after several attempts. Check System Logs for what the browser reported, then try again.",
              },
            },
          });
          break;
        }
        // connect() re-attaches the message listener itself, so this no longer ends with a session
        // that looks connected and silently collects nothing.
        //
        // The group sync is the other half, and its absence here is what left a freshly linked
        // number reporting CONNECTED with a dead group list — see `resyncAndCatchUpAfterConnect`.
        // The catch-up sweep moved inside it so it runs AFTER the sync: it used to be awaited here
        // to "fill the gap before reporting the command done", which was right when nothing else
        // followed, and is wrong now that a recovered message needs a group row to resolve against.
        resyncAndCatchUpAfterConnect(accountId, provider, "a RECONNECT command");
        await prisma.workerCommand.update({
          where: { id: command.id },
          data: {
            status: "DONE",
            processedAt: new Date(),
            // Honest about what is still running: the session is up, the roster and the backlog are
            // being worked through behind this row rather than before it.
            result: { reconnected: true, groupSyncAndCatchUp: "running in the background" },
          },
        });
        break;
      }

      case "LOGOUT": {
        // provider.logout() never throws by design (see its own doc comment) -- whatever happens
        // remotely, we still want to land on DISCONNECTED locally and clear the stale phone number
        // so the dashboard doesn't keep showing an account that's no longer actually connected.
        // Before the logout and, above all, before the deactivation below: a sync that had already
        // read the list would otherwise switch every group back on at its stamp.
        await cancelGroupSync(accountId, "Stopped because the account was logged out.");
        await provider.logout();
        await prisma.whatsAppAccount.update({
          where: { id: accountId },
          data: {
            phoneNumber: null,
            // `pairingPhoneNumber` goes with it, and for a sharper reason than tidiness. Logging
            // out exists so a DIFFERENT number can be linked here; leaving the old one behind
            // means the next connection attempt silently requests a link code for the number that
            // just left, and shows it as though it were for the new one. Clearing it makes the
            // dialog ask for the number that has to change.
            //
            // `pairingMethod` is deliberately KEPT. That is a preference about how this operator
            // likes to link — a screen with no phone camera, a number in another office — and it
            // stays true of the next number too. With no number saved, `readPairingPreference`
            // falls back to a QR and says so, so keeping it can never strand the account.
            pairingPhoneNumber: null,
          },
        });

        // Logging out is "this account left every group" as far as this app can tell, and it is
        // the one case syncGroups' own deactivation sweep can never cover: that sweep runs from a
        // live provider result, and a logged-out account never produces one again. Without this
        // the rows stay isActive, so the chat inbox keeps listing conversations this number can no
        // longer reach and every send fails membership verification at the queue — which is
        // exactly how it looked: a full inbox where nothing could be answered.
        //
        // Deactivate only. isMonitored, aiAutomationEnabled and the rest stay untouched, because
        // logging the SAME number back in must restore the setup rather than silently wipe it —
        // syncGroups' upsert sets isActive true again and everything is as it was. Deleting these
        // rows is never an option: Message, SupportActivity, SupportSession, escalation cases and
        // AI decisions all hang off them.
        const { count: deactivated } = await prisma.whatsAppGroup.updateMany({
          where: { accountId, isActive: true },
          data: { isActive: false },
        });
        if (deactivated > 0) {
          await logSystemEvent("INFO", "commands", "Deactivated an account's groups after logout", {
            accountId,
            deactivated,
            note: "Settings kept — reconnecting the same number restores them.",
          });
        }

        await prisma.workerCommand.update({
          where: { id: command.id },
          data: { status: "DONE", processedAt: new Date(), result: { loggedOut: true, groupsDeactivated: deactivated } },
        });
        break;
      }

      case "RESYNC_GROUPS": {
        // NOT awaited. This processor is strictly serial and one global queue, and a sync can take
        // minutes (three attempts at up to 150s); awaiting it here parked every other account's
        // commands — their own resync, Show QR, Reconnect — behind this account's roster. The
        // command stays PROCESSING until the sync settles, so the dashboard's per-account dedup
        // still sees it in flight, and a second request for this account joins the running sync.
        const commandId = command.id;
        void syncGroupsWithTimeoutAndRetry(accountId, provider)
          .then((count) =>
            prisma.workerCommand.update({
              where: { id: commandId },
              data: { status: "DONE", processedAt: new Date(), result: { groupsSynced: count } },
            }),
          )
          .catch((err) =>
            prisma.workerCommand
              .update({
                where: { id: commandId },
                // Stopped by a Logout/Reconnect is not a failure of the resync; it is recorded as
                // what happened (WorkerCommandStatus has no CANCELLED, and the account's own
                // groupSyncStatus carries CANCELLED for the dashboard).
                data:
                  err instanceof GroupSyncCancelledError
                    ? { status: "DONE", processedAt: new Date(), result: { cancelled: true, reason: err.message } }
                    : { status: "FAILED", processedAt: new Date(), result: { error: (err as Error).message } },
              })
              .catch((writeErr) => console.error(`[groupsync] could not settle RESYNC_GROUPS ${commandId}`, writeErr)),
          );
        break;
      }

      case "GET_GROUP_PARTICIPANT_COUNT": {
        const payload = command.payload as { groupId?: string } | null;
        if (!payload?.groupId) {
          throw new Error("GET_GROUP_PARTICIPANT_COUNT requires { groupId } in the command payload.");
        }
        const group = await prisma.whatsAppGroup.findUniqueOrThrow({ where: { id: payload.groupId } });
        const count = await provider.getGroupParticipantCount(group.whatsappGroupId);
        await prisma.whatsAppGroup.update({ where: { id: group.id }, data: { participantCount: count } });
        await prisma.workerCommand.update({
          where: { id: command.id },
          data: { status: "DONE", processedAt: new Date(), result: { groupId: group.id, participantCount: count } },
        });
        break;
      }

      case "GET_GROUP_PARTICIPANTS": {
        const payload = command.payload as { groupId?: string } | null;
        if (!payload?.groupId) {
          throw new Error("GET_GROUP_PARTICIPANTS requires { groupId } in the command payload.");
        }
        const group = await prisma.whatsAppGroup.findUniqueOrThrow({ where: { id: payload.groupId } });
        const participants = await provider.getGroupParticipants(group.whatsappGroupId);
        // The roster is returned in the command result rather than stored on the group: it is a
        // point-in-time answer to "who is in here right now", consumed immediately by the person
        // who asked, and persisting it would create a second copy of WhatsApp's own membership
        // that nothing keeps in step.
        await prisma.whatsAppGroup.update({
          where: { id: group.id },
          data: { participantCount: participants.length },
        });
        await prisma.workerCommand.update({
          where: { id: command.id },
          data: {
            status: "DONE",
            processedAt: new Date(),
            // Prisma's Json input needs a plain serialisable shape, not an interface with
            // no index signature.
            result: { groupId: group.id, participants: participants.map((p) => ({ ...p })) },
          },
        });
        break;
      }

      case "SEND_LIVE_TEST": {
        const payload = command.payload as { chatId?: string; body?: string } | null;
        if (!payload?.chatId || !payload?.body) {
          throw new Error("SEND_LIVE_TEST requires { chatId, body } in the command payload.");
        }
        const result = await provider.sendMessage(payload.chatId, payload.body);
        await prisma.workerCommand.update({
          where: { id: command.id },
          data: {
            status: result.success ? "DONE" : "FAILED",
            processedAt: new Date(),
            result: { success: result.success, error: result.error ?? null },
          },
        });
        break;
      }

      case "REACT_TO_MESSAGE": {
        const payload = command.payload as { whatsappMessageId?: string; emoji?: string } | null;
        if (!payload?.whatsappMessageId || !payload?.emoji) {
          throw new Error("REACT_TO_MESSAGE requires { whatsappMessageId, emoji } in the command payload.");
        }
        const result = await provider.reactToMessage(payload.whatsappMessageId, payload.emoji);
        await prisma.workerCommand.update({
          where: { id: command.id },
          data: {
            status: result.success ? "DONE" : "FAILED",
            processedAt: new Date(),
            result: { success: result.success, error: result.error ?? null },
          },
        });
        break;
      }

      case "EDIT_MESSAGE": {
        const payload = command.payload as { whatsappMessageId?: string; newBody?: string } | null;
        if (!payload?.whatsappMessageId || !payload?.newBody) {
          throw new Error("EDIT_MESSAGE requires { whatsappMessageId, newBody } in the command payload.");
        }
        const result = await provider.editMessage(payload.whatsappMessageId, payload.newBody);
        // The stored Message row is deliberately left untouched here. It is the record of what was
        // SENT — echoing the edit back into it would make history rewrite itself, and WhatsApp's
        // own edit indicator on the customer's device is the actual record that a message changed.
        // A future "edited" surface, if one is ever wanted, belongs to a real edit-history table,
        // not to silently overwriting `Message.body`.
        await prisma.workerCommand.update({
          where: { id: command.id },
          data: {
            status: result.success ? "DONE" : "FAILED",
            processedAt: new Date(),
            result: { success: result.success, error: result.error ?? null },
          },
        });
        break;
      }

      case "CREATE_GROUP": {
        const payload = command.payload as { groupName?: string; contactPhoneNumbers?: string[] } | null;
        if (!payload?.groupName || !payload?.contactPhoneNumbers?.length) {
          throw new Error("CREATE_GROUP requires { groupName, contactPhoneNumbers } in the command payload.");
        }
        // Digits only — the caller (the server action) is expected to have already validated these,
        // but this command can also be replayed by a retry, so the normalisation happens here too
        // rather than trusted from whatever the payload happened to carry.
        const digits = payload.contactPhoneNumbers.map((n) => n.replace(/\D/g, "")).filter(Boolean);
        const result = await provider.createGroup(payload.groupName, digits);
        await prisma.workerCommand.update({
          where: { id: command.id },
          data: {
            status: result.success ? "DONE" : "FAILED",
            processedAt: new Date(),
            result: result.success
              ? { success: true, whatsappGroupId: result.whatsappGroupId, name: result.name }
              : { success: false, error: result.error },
          },
        });
        break;
      }

      case "JOIN_GROUP": {
        const payload = command.payload as { inviteLink?: string } | null;
        if (!payload?.inviteLink) {
          throw new Error("JOIN_GROUP requires { inviteLink } in the command payload.");
        }
        const result = await provider.joinGroupByInviteLink(payload.inviteLink);
        await prisma.workerCommand.update({
          where: { id: command.id },
          data: {
            status: result.success ? "DONE" : "FAILED",
            processedAt: new Date(),
            result: result.success
              ? { success: true, whatsappGroupId: result.whatsappGroupId }
              : { success: false, error: result.error },
          },
        });
        break;
      }

      case "UPDATE_PROFILE": {
        const payload = command.payload as
          | { displayName?: string; about?: string; pictureDataUrl?: string }
          | null;
        if (!payload || (payload.displayName === undefined && payload.about === undefined && payload.pictureDataUrl === undefined)) {
          throw new Error("UPDATE_PROFILE requires at least one of { displayName, about, pictureDataUrl }.");
        }
        const result = await provider.updateProfile(payload);
        // A partial success — the name changed but the picture upload failed, say — is still
        // reported as DONE with the per-field result inside it, never FAILED outright: the caller
        // asked for up to three independent things, and one failing must not hide that the other
        // two genuinely went through.
        await prisma.workerCommand.update({
          where: { id: command.id },
          data: { status: "DONE", processedAt: new Date(), result: { ...result } },
        });
        break;
      }

      default:
        await prisma.workerCommand.update({
          where: { id: command.id },
          data: { status: "FAILED", processedAt: new Date(), result: { error: "Unknown command type." } },
        });
    }
  } catch (err) {
    await prisma.workerCommand.update({
      where: { id: command.id },
      data: {
        status: "FAILED",
        processedAt: new Date(),
        result: { error: (err as Error).message },
      },
    });
  }
}

export function startCommandProcessor(
  registry: ProviderRegistry,
  intervalMs = 1500,
): NodeJS.Timeout {
  // ENGINEERING_STANDARDS.md §9 (no concurrent/conflicting commands): plain setInterval does NOT
  // wait for its callback to resolve before scheduling the next tick. A RECONNECT can take well
  // over intervalMs (real WhatsApp auth), so without this guard a later tick could claim and start
  // a second command (e.g. RESYNC_GROUPS) WHILE the first is still running against the same
  // provider/browser session. This flag makes the loop strictly serial -- never more than one
  // command in flight at a time.
  // Declared before the first tick, so a loop that dies on its very first run shows as
  // "never ticked" rather than not appearing in the liveness view at all.
  registerLoop(LOOP_NAME, intervalMs);
  let processing = false;
  return setInterval(() => {
    if (processing) return;
    processing = true;
    // Wrapped so shutdown can wait for a claim already in flight and refuse to start a new one.
    // Without it, SIGTERM during this tick killed the process mid-work and left the claimed row
    // PROCESSING until the next boot requeued and re-ran it — see lifecycle.ts.
    void trackTick(() => processOneCommandViaRegistry(registry))
      .catch((err) => {
        console.error("[commands] unexpected error processing worker command", err);
      })
      .finally(() => {
        processing = false;
        // Stamped when the tick FINISHES, which is the only moment that proves the loop is not
        // wedged — a guard that never clears is exactly how one of these dies silently.
        recordLoopTick(LOOP_NAME, intervalMs);
      });
  }, intervalMs);
}
