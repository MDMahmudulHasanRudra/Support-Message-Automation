import { trackTick } from "../lifecycle.js";
import { prisma } from "@support-automation/db";
import { SessionNotReadyError, type WhatsAppProvider } from "../provider/WhatsAppProvider.js";
import type { ProviderRegistry } from "../provider/ProviderRegistry.js";
import { logSystemEvent } from "../logging/logSystemEvent.js";
import { processOneGroupKnowledgeBuild } from "../knowledge/groupKnowledgeJob.js";
import { processOneAiAnalysisBatch } from "../learning/aiAnalysisJob.js";
import { runTeamsSync } from "../teams/graphSync.js";
import { runForgeKnowledgeSync } from "../forge/forgeKnowledgeJob.js";
import { buildCommunicationStyleProfile } from "../knowledge/communicationStyleJob.js";
import { catchUpMissedMessages } from "../pipeline/catchUpMissedMessages.js";
import { withTimeout } from "../util/withTimeout.js";
// From its own module, not from ProviderRegistry — that would close an import cycle, since the
// registry imports the group sync from this file.
import { connectWithRetry } from "../provider/connectWithRetry.js";
import { recordLoopTick, registerLoop } from "../health/loopLiveness.js";
import { shouldHoldDeactivationSweep } from "./groupSyncGuard.js";

/** Name this loop reports itself under in the per-loop liveness view. */
const LOOP_NAME = "command-processor";


/**
 * PHASE 5.2: discovers/updates the account's monitored groups from the live provider.
 *
 * Still idempotent, which is the property that matters — safe to call repeatedly (retries, a
 * manual RESYNC_GROUPS, a future scheduled resync) without ever duplicating a row or losing groups
 * synced by an earlier, since-failed attempt. `@@unique([accountId, whatsappGroupId])` remains the
 * real guarantee of that, exactly as it was when this was written as a per-group upsert.
 */
export async function syncGroups(accountId: string, provider: WhatsAppProvider): Promise<number> {
  const groups = await provider.getGroups();
  const syncedAt = new Date();

  // Four statements, not 1,848.
  //
  // This was a sequential `upsert` per group. On this deployment's roster that is 1,848 round
  // trips, every one of them a real UPDATE — `lastSyncedAt: new Date()` moves on every pass, so
  // the "nothing changed" case, which is nearly all of them, still rewrote the row, its indexes
  // and a dead tuple for the vacuum. And it runs inside the STRICTLY SERIAL command processor, so
  // for however long that took, no other dashboard action could be processed at all. It is also
  // the most likely reason this sync has been timing out in production (GROUP_SYNC_TIMEOUT on 7,
  // 11 and 18 Sep 2026) — at 150s for 1,848 upserts the write half alone needs ~80ms per group to
  // blow the budget, before `getGroups()` has cost anything.
  //
  // Identical results, by construction: every group the provider returned ends up present, named,
  // active and stamped, exactly as before.
  const existing = await prisma.whatsAppGroup.findMany({
    where: { accountId },
    select: { whatsappGroupId: true, name: true },
  });
  const nameById = new Map(existing.map((row) => [row.whatsappGroupId, row.name]));

  const fresh = groups.filter((group) => !nameById.has(group.whatsappGroupId));
  // A rename is rare and has to be per-row, because the value differs per group. Reading the
  // current names first is what turns "1,848 updates" into "however many were actually renamed",
  // which in a steady state is none.
  const renamed = groups.filter(
    (group) => nameById.has(group.whatsappGroupId) && nameById.get(group.whatsappGroupId) !== group.name,
  );

  if (fresh.length > 0) {
    // skipDuplicates because a concurrent sync for the same account is guarded against but a
    // partially-applied earlier attempt is not — the unique constraint stays the real authority.
    await prisma.whatsAppGroup.createMany({
      data: fresh.map((group) => ({
        accountId,
        whatsappGroupId: group.whatsappGroupId,
        name: group.name,
        lastSyncedAt: syncedAt,
      })),
      skipDuplicates: true,
    });
    console.log(`[groupsync] GROUP_SYNC_NEW ${fresh.length} group(s)`);
  }

  for (const group of renamed) {
    await prisma.whatsAppGroup.update({
      where: { accountId_whatsappGroupId: { accountId, whatsappGroupId: group.whatsappGroupId } },
      data: { name: group.name },
    });
  }
  if (renamed.length > 0) console.log(`[groupsync] GROUP_SYNC_RENAMED ${renamed.length} group(s)`);

  if (groups.length > 0) {
    // The stamp and the reactivation, for every group in one statement. `isActive: true` matters
    // here: a group the account rejoined must come back, and the sweep below is what took it away.
    await prisma.whatsAppGroup.updateMany({
      where: { accountId, whatsappGroupId: { in: groups.map((g) => g.whatsappGroupId) } },
      data: { lastSyncedAt: syncedAt, isActive: true },
    });
  }

  // A group the account has since left/been removed from no longer appears in getAllGroups() —
  // soft-deactivate it (never delete: Message.groupId history must keep a valid FK). Idempotent:
  // re-running this against the same result set is a no-op for groups already isActive: false.
  //
  // Guard: an empty `groups` result (e.g. getGroups() called while the provider's client is
  // temporarily null during a reconnect) must NEVER be treated as "the account left every
  // group" — that would mass-deactivate the entire table from a transient connection blip. Only
  // run the sweep when we actually have a real result set to compare against.
  if (groups.length > 0) {
    const currentWhatsappGroupIds = groups.map((g) => g.whatsappGroupId);
    const missingWhere = { accountId, isActive: true, whatsappGroupId: { notIn: currentWhatsappGroupIds } };
    const wouldDeactivate = await prisma.whatsAppGroup.count({ where: missingWhere });
    // Counted after the reactivation above, so this is the active roster the sweep would cut.
    const activeBefore = await prisma.whatsAppGroup.count({ where: { accountId, isActive: true } });

    if (shouldHoldDeactivationSweep(activeBefore, wouldDeactivate)) {
      // See groupSyncGuard.ts: this read is far more likely incomplete than a real mass exit.
      await logSystemEvent("WARN", "provider", "GROUP_SYNC_SWEEP_HELD", {
        accountId,
        returned: groups.length,
        activeBefore,
        wouldDeactivate,
        note: "WhatsApp returned far fewer groups than are active. Nothing was deactivated; a later sync will finish the list.",
      });
    } else if (wouldDeactivate > 0) {
      const deactivated = await prisma.whatsAppGroup.updateMany({ where: missingWhere, data: { isActive: false } });
      if (deactivated.count > 0) {
        console.log(`[groupsync] GROUP_SYNC_DEACTIVATED ${deactivated.count} group(s) no longer returned by the account`);
      }
    }
  }

  return groups.length;
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
 * Module-level, not per-call: index.ts's fire-and-forget post-connect sync
 * and an explicit RESYNC_GROUPS command are two independent call sites with
 * no shared state otherwise — without this, they could genuinely run
 * concurrently (ENGINEERING_STANDARDS.md §9's "conflicting group sync
 * operations"), and the isActive deactivation sweep is only correct against
 * a single, complete getGroups() snapshot. A second caller that arrives
 * while one is already running gets the SAME in-flight result instead of
 * starting a competing sync.
 *
 * Keyed by accountId, because the conflict this guards against is per-session: two accounts sync
 * different providers and write disjoint rows. A single shared slot meant the second account
 * connecting during startup was handed the FIRST account's promise, so its own getGroups() never
 * ran — it ended up with zero groups while the log reported the other account's count.
 */
const syncInFlight = new Map<string, Promise<number>>();

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

  const run = runSyncWithRetry(accountId, provider);
  syncInFlight.set(accountId, run);
  try {
    return await run;
  } finally {
    syncInFlight.delete(accountId);
  }
}

async function runSyncWithRetry(accountId: string, provider: WhatsAppProvider): Promise<number> {
  const attempts = GROUP_SYNC_RETRY_DELAYS_MS.length + 1;
  await logSystemEvent("INFO", "provider", "GROUP_SYNC_STARTED", { accountId });

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const count = await withTimeout(syncGroups(accountId, provider), GROUP_SYNC_TIMEOUT_MS, "group sync");
      await logSystemEvent("INFO", "provider", "GROUP_SYNC_COMPLETED", { accountId, groupCount: count, attempt });
      return count;
    } catch (err) {
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
      if (isLastAttempt) throw err;
      const delayMs = GROUP_SYNC_RETRY_DELAYS_MS[attempt - 1];
      await logSystemEvent("INFO", "provider", "GROUP_SYNC_RETRY", { nextAttempt: attempt + 1, delayMs });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
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
  syncGroupsWithTimeoutAndRetry(accountId, provider)
    .then((groupCount) => {
      console.log(`[worker] synced ${groupCount} group(s) for account ${accountId} after ${source}`);
    })
    .catch((err) => {
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
    .finally(() => scheduleFollowUpSyncs(accountId, provider, source));
}

/**
 * Sync again a few minutes after connecting, because the first read is often not the whole list.
 *
 * A number that has just been linked receives its chats from the phone over several minutes, and
 * the sync above runs the moment `create()` resolves — so it reads whatever has arrived by then.
 * On 24 Sep 2026 that was 498 of 1,952 groups, and nothing ever read the list again unless somebody
 * pressed Resync, so three quarters of the roster stayed missing from the inbox. These passes pick
 * up the rest once it has landed. Each one only ADDS and reactivates groups it can see (the
 * deactivation sweep holds on a list that is still short — see groupSyncGuard.ts), and each is
 * skipped if the session is no longer connected by then.
 *
 * Bounded to two, on purpose: this is filling in after a connect, not a polling loop over a
 * 1,952-group roster. `unref` so a pending pass never holds the process open at shutdown.
 */
const FOLLOW_UP_SYNC_DELAYS_MS = [5 * 60_000, 15 * 60_000];

function scheduleFollowUpSyncs(accountId: string, provider: WhatsAppProvider, source: string): void {
  for (const delayMs of FOLLOW_UP_SYNC_DELAYS_MS) {
    const timer = setTimeout(() => {
      if (provider.getConnectionStatus() !== "CONNECTED") return;
      syncGroupsWithTimeoutAndRetry(accountId, provider)
        .then((groupCount) => {
          console.log(
            `[worker] follow-up sync ${Math.round(delayMs / 60_000)}m after ${source}: ${groupCount} group(s) for account ${accountId}`,
          );
        })
        .catch((err) => console.error(`[worker] follow-up group sync failed for account ${accountId}`, err));
    }, delayMs);
    timer.unref?.();
  }
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
  const result = await prisma.workerCommand.updateMany({
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
  const candidate = await prisma.workerCommand.findFirst({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
  });
  if (!candidate) return null;

  const claim = await prisma.workerCommand.updateMany({
    where: { id: candidate.id, status: "PENDING" },
    // Stamped in the same write that claims the row, so a command is never PROCESSING without a
    // time to age it from. This is what lets the periodic sweep leave live work alone.
    data: { status: "PROCESSING", startedAt: new Date() },
  });
  if (claim.count === 0) return null;

  return prisma.workerCommand.findUniqueOrThrow({ where: { id: candidate.id } });
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
  if (command.type === "AI_ANALYSIS_BATCH") {
    await executeAiAnalysisBatchCommand(command);
    return true;
  }
  if (command.type === "TEAMS_SYNC_NOW") {
    await executeTeamsSyncNowCommand(command);
    return true;
  }
  if (command.type === "BUILD_GROUP_KNOWLEDGE") {
    await executeBuildGroupKnowledgeCommand(command);
    return true;
  }
  await executeClaimedCommand(command, accountId, provider);
  return true;
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

  // Account-agnostic: scans PatternCandidate rows globally, needs no WhatsApp session at all —
  // must be handled before the accountId-required check just below.
  if (command.type === "AI_ANALYSIS_BATCH") {
    await executeAiAnalysisBatchCommand(command);
    return true;
  }

  // Also account-agnostic: there is at most one connected TeamsAccount, and Graph API calls need
  // no WhatsApp session either.
  if (command.type === "TEAMS_SYNC_NOW") {
    await executeTeamsSyncNowCommand(command);
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

/** The dashboard's Teams Integration "Sync Now" button — runs one sync pass immediately instead
 * of waiting for startTeamsSyncProcessor's own interval. Never touches a WhatsApp provider/account. */
async function executeTeamsSyncNowCommand(command: ClaimedCommand): Promise<void> {
  try {
    const result = await runTeamsSync();
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
        const count = await syncGroupsWithTimeoutAndRetry(accountId, provider);
        await prisma.workerCommand.update({
          where: { id: command.id },
          data: { status: "DONE", processedAt: new Date(), result: { groupsSynced: count } },
        });
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
