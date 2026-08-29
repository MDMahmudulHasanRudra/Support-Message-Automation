import { prisma } from "@support-automation/db";
import type { WhatsAppProvider } from "../provider/WhatsAppProvider.js";
import type { ProviderRegistry } from "../provider/ProviderRegistry.js";
import { logSystemEvent } from "../logging/logSystemEvent.js";
import { processOneGroupKnowledgeBuild } from "../knowledge/groupKnowledgeJob.js";
import { processOneAiAnalysisBatch } from "../learning/aiAnalysisJob.js";
import { runTeamsSync } from "../teams/graphSync.js";

const GROUP_SYNC_PROGRESS_INTERVAL = 250;

/**
 * PHASE 5.2: discovers/updates the account's monitored groups from the live
 * provider. Upsert-based on purpose — safe to call repeatedly (retries,
 * manual RESYNC_GROUPS, a future scheduled resync) without ever duplicating
 * a row or losing groups synced by an earlier, since-failed attempt.
 */
export async function syncGroups(accountId: string, provider: WhatsAppProvider): Promise<number> {
  const groups = await provider.getGroups();
  for (const [i, group] of groups.entries()) {
    await prisma.whatsAppGroup.upsert({
      where: { accountId_whatsappGroupId: { accountId, whatsappGroupId: group.whatsappGroupId } },
      update: { name: group.name, lastSyncedAt: new Date(), isActive: true },
      create: {
        accountId,
        whatsappGroupId: group.whatsappGroupId,
        name: group.name,
        lastSyncedAt: new Date(),
      },
    });
    if ((i + 1) % GROUP_SYNC_PROGRESS_INTERVAL === 0) {
      console.log(`[groupsync] GROUP_SYNC_PROGRESS ${i + 1}/${groups.length}`);
    }
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
    const deactivated = await prisma.whatsAppGroup.updateMany({
      where: { accountId, isActive: true, whatsappGroupId: { notIn: currentWhatsappGroupIds } },
      data: { isActive: false },
    });
    if (deactivated.count > 0) {
      console.log(`[groupsync] GROUP_SYNC_DEACTIVATED ${deactivated.count} group(s) no longer returned by the account`);
    }
  }

  return groups.length;
}

const GROUP_SYNC_TIMEOUT_MS = Number(process.env.WHATSAPP_GROUP_SYNC_TIMEOUT_MS) || 150_000;
// Bounded, same spirit as index.ts's CONNECT_RETRY_DELAYS_MS — not unlimited.
const GROUP_SYNC_RETRY_DELAYS_MS = [10_000, 30_000];

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`group sync timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

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
 */
let syncInFlight: Promise<number> | null = null;

export async function syncGroupsWithTimeoutAndRetry(
  accountId: string,
  provider: WhatsAppProvider,
): Promise<number> {
  if (syncInFlight) {
    console.log("[groupsync] GROUP_SYNC_ALREADY_IN_PROGRESS -- reusing the in-flight sync instead of starting a second one");
    return syncInFlight;
  }

  syncInFlight = runSyncWithRetry(accountId, provider);
  try {
    return await syncInFlight;
  } finally {
    syncInFlight = null;
  }
}

async function runSyncWithRetry(accountId: string, provider: WhatsAppProvider): Promise<number> {
  const attempts = GROUP_SYNC_RETRY_DELAYS_MS.length + 1;
  await logSystemEvent("INFO", "provider", "GROUP_SYNC_STARTED", { accountId });

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const count = await withTimeout(syncGroups(accountId, provider), GROUP_SYNC_TIMEOUT_MS);
      await logSystemEvent("INFO", "provider", "GROUP_SYNC_COMPLETED", { groupCount: count, attempt });
      return count;
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      const isTimeout = message.includes("timed out");
      const isLastAttempt = attempt === attempts;
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

async function claimNextCommand() {
  const candidate = await prisma.workerCommand.findFirst({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
  });
  if (!candidate) return null;

  const claim = await prisma.workerCommand.updateMany({
    where: { id: candidate.id, status: "PENDING" },
    data: { status: "PROCESSING" },
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

async function executeClaimedCommand(command: ClaimedCommand, accountId: string, provider: WhatsAppProvider): Promise<void> {
  try {
    switch (command.type) {
      case "GET_QR": {
        const account = await prisma.whatsAppAccount.findUnique({
          where: { id: accountId },
          select: { qrCode: true, qrUpdatedAt: true },
        });
        await prisma.workerCommand.update({
          where: { id: command.id },
          data: { status: "DONE", processedAt: new Date(), result: { qrCode: account?.qrCode ?? null } },
        });
        break;
      }

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
        await provider.connect();
        await prisma.workerCommand.update({
          where: { id: command.id },
          data: { status: "DONE", processedAt: new Date(), result: { reconnected: true } },
        });
        break;
      }

      case "LOGOUT": {
        // provider.logout() never throws by design (see its own doc comment) -- whatever happens
        // remotely, we still want to land on DISCONNECTED locally and clear the stale phone number
        // so the dashboard doesn't keep showing an account that's no longer actually connected.
        await provider.logout();
        await prisma.whatsAppAccount.update({ where: { id: accountId }, data: { phoneNumber: null } });
        await prisma.workerCommand.update({
          where: { id: command.id },
          data: { status: "DONE", processedAt: new Date(), result: { loggedOut: true } },
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
  let processing = false;
  return setInterval(() => {
    if (processing) return;
    processing = true;
    processOneCommandViaRegistry(registry)
      .catch((err) => {
        console.error("[commands] unexpected error processing worker command", err);
      })
      .finally(() => {
        processing = false;
      });
  }, intervalMs);
}
