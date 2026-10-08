import { checkDatabaseConnection } from "@support-automation/db";
import { platformPrisma } from "./db.js";
import type { Prisma } from "@prisma/client";
import { startHealthServer, type WorkerHealthState } from "./health/server.js";
import { ProviderRegistry } from "./provider/ProviderRegistry.js";
import { ensureLegacyAccountExists, ensurePrimaryAccountExists, findConnectableAccounts } from "./provider/accountProvisioning.js";
import { startAccountRegistrySync } from "./provider/accountRegistrySync.js";
import { startOutboundQueueProcessor } from "./queue/outboundQueueProcessor.js";
import { startGroupParticipantAddProcessor } from "./queue/groupParticipantAddProcessor.js";
import { startGroupParticipantCheckProcessor } from "./queue/groupParticipantCheckProcessor.js";
import { startGroupAdminPromotionProcessor } from "./queue/groupAdminPromotionProcessor.js";
import { createMediaStorageFromEnv } from "@support-automation/media-storage";
import { startMediaDownloadProcessor } from "./media/mediaDownloadProcessor.js";
import { startMediaCleanupProcessor } from "./media/mediaCleanupProcessor.js";
import { startNotificationDispatcher } from "./notifications/dispatcher.js";
import { TeamsProvider } from "./notifications/TeamsProvider.js";
import { WhatsAppNotificationProvider } from "./notifications/WhatsAppNotificationProvider.js";
import { startCommandProcessor } from "./commands/commandProcessor.js";
import {
  reconcileAccountStatusesOnBoot,
  runStuckWorkRecovery,
  startStuckWorkRecoveryProcessor,
} from "./recovery.js";
import { awaitQuiescence, beginShutdown, installProcessGuards } from "./lifecycle.js";
import { startMessageRecoveryProcessor } from "./pipeline/messageRecovery.js";
import { startCollectionWatchdog } from "./health/collectionWatchdog.js";
import { readLoops, recordLoopTick, registerLoop } from "./health/loopLiveness.js";
import { logSystemEvent } from "./logging/logSystemEvent.js";
import { startEscalationProcessor } from "./escalation/escalationProcessor.js";
import { startMoodDetectionProcessor } from "./mood/moodProcessor.js";
import { startSupportAssignmentProcessor } from "./supportAssignment/processor.js";
import { startSessionSegmentationProcessor } from "./learning/sessionSegmentationProcessor.js";
import { startPatternDetectionProcessor } from "./learning/patternDetectionProcessor.js";
import { startAiAnalysisProcessor } from "./learning/aiAnalysisProcessor.js";
import { startGroupKnowledgeProcessor } from "./knowledge/groupKnowledgeProcessor.js";
import { startKnowledgeImportProcessor } from "./knowledge/knowledgeImportProcessor.js";
import { startCommunicationStyleProcessor } from "./knowledge/communicationStyleProcessor.js";
import { startSandboxProcessor } from "./sandbox/sandboxProcessor.js";
import { startConversationAnalysisProcessor } from "./knowledge/conversationAnalysisProcessor.js";
import {
  ensureForgeSettings,
  startForgeKnowledgeProcessor,
  startForgeResearchProcessor,
} from "./forge/forgeProcessor.js";
import { provisionAiProviderFromEnv } from "./bootstrap/provisionAiProviderFromEnv.js";

const HEALTH_PORT = Number(process.env.WORKER_HEALTH_PORT ?? 4100);
const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * How long shutdown waits for work already in flight. Long enough for a send or a webhook to
 * finish, short enough to stay well inside the ten seconds Docker allows between SIGTERM and
 * SIGKILL — being killed halfway through the wait is the outcome this exists to avoid.
 */
const SHUTDOWN_GRACE_MS = 8_000;

async function main() {
  // Before anything else: one forgotten `.catch()` in any of the eighteen loops must not be able to
  // take the whole worker down. See lifecycle.ts for why a rejection and an exception get
  // different treatment.
  installProcessGuards();

  const state: WorkerHealthState = { startedAt: Date.now(), lastHeartbeatAt: Date.now() };
  const healthServer = startHealthServer(state, HEALTH_PORT);
  console.log(`[worker] health server listening on 127.0.0.1:${HEALTH_PORT}`);

  const dbConnected = await checkDatabaseConnection();
  console.log(`[worker] started, db=${dbConnected ? "connected" : "unreachable"}`);
  if (!dbConnected) {
    throw new Error("Cannot start without a database connection.");
  }

  const recovered = await runStuckWorkRecovery({ atBoot: true });
  if (
    recovered.outbound +
      recovered.notifications +
      recovered.participantAdds +
      recovered.participantChecks +
      recovered.mediaDownloads +
      recovered.commands +
      recovered.mood >
    0
  ) {
    console.log(
      `[worker] crash recovery: requeued ${recovered.outbound} outbound message(s), ${recovered.notifications} notification(s), ${recovered.participantAdds} group-participant-add item(s), ${recovered.participantChecks} membership check(s), ${recovered.mediaDownloads} media download(s); failed ${recovered.commands} interrupted worker command(s)`,
    );
  }

  // Media storage (MEDIA_STORAGE.md): the same directory the dashboard reads from. Unset, media is
  // still recorded per message and its downloads wait, each saying why — never silently dropped.
  const mediaStorage = createMediaStorageFromEnv();
  if (!mediaStorage) {
    console.warn("[worker] MEDIA_STORAGE_DIR is not set: attachments are recorded but their files are not downloaded.");
  }

  // Nothing clears connection status on the way down, so every account is still reporting whatever
  // it said before this process existed. Correct that before the connect loop below, which takes
  // minutes across several accounts — minutes during which the dashboard would otherwise show
  // sessions this process does not have.
  await reconcileAccountStatusesOnBoot();

  // Backward compatibility, load-bearing: this is the exact account (same sessionDataPath,
  // same sessionId) every pre-multi-account install already has — see ensureLegacyAccountExists's
  // own doc comment. It also becomes Primary automatically if this is a fresh install.
  const legacyAccount = await ensureLegacyAccountExists();
  await ensurePrimaryAccountExists();

  // Both are idempotent and never fatal: a deployment that supplies OPENROUTER_* or FORGE_* in
  // its environment gets configured without anyone opening the dashboard, and one that does not
  // is left exactly as it was.
  await provisionAiProviderFromEnv();
  await ensureForgeSettings();

  const registry = new ProviderRegistry();

  // Connecting accounts is NOT on the startup path, and that is the whole point.
  //
  // It used to be: a sequential `await registry.connectAccount()` loop right here, before a single
  // interval below existed. `connect()` waits up to ten minutes for a QR scan, and gets three
  // attempts with backoff — so one account nobody scans held the ENTIRE worker for about half an
  // hour. No heartbeat, so the dashboard said "the worker is not responding". No command
  // processor, so Show QR / Reconnect / Logout all wrote WorkerCommand rows that nothing would
  // ever read — the buttons appeared to work and did nothing. No outbound queue, so every reply
  // and alert sat still. And with more than one account, each one's wait was added to the next.
  //
  // The irony is that the only thing that could rescue it — the loop that reconnects a dropped
  // session — was itself waiting behind the account that was stuck.
  //
  // `startAccountRegistrySync` already does exactly this job, and its doc comment already says so:
  // it connects every provisioned account the registry does not yet hold, one at a time, never
  // concurrently. So it owns the initial connect too. One loop, one overlap guard, one place where
  // the never-two-concurrent-connects rule is enforced — rather than two call sites that have to
  // agree with each other while one of them blocks everything.
  const accountsToConnect = await findConnectableAccounts();
  console.log(`[worker] ${accountsToConnect.length} account(s) will be connected in the background: ${accountsToConnect.map((a) => a.label).join(", ")}`);
  await logSystemEvent("INFO", "worker", "Worker starting up", {
    accountIds: accountsToConnect.map((a) => a.id),
    legacyAccountId: legacyAccount.id,
  });

  const intervals: NodeJS.Timeout[] = [
    startOutboundQueueProcessor(registry),
    startGroupParticipantAddProcessor(registry),
    // Reads rosters so an operator can see who is genuinely missing before a single add is spent.
    startGroupParticipantCheckProcessor(registry),
    startGroupAdminPromotionProcessor(registry),
    // Media files are fetched here, never on the message path, and removed here by retention.
    startMediaDownloadProcessor({ storage: mediaStorage, providers: registry }),
    startMediaCleanupProcessor(mediaStorage),
    startEscalationProcessor(),
    // Mood Detection: finishes recorded readings and runs each alert's actions (a no-op while off).
    startMoodDetectionProcessor(),
    // Support Assignment SLA, escalation and its safety net (SUPPORT_ASSIGNMENT.md). One settings
    // read per project per tick while the module is off.
    startSupportAssignmentProcessor(),
    // Conversation Learning Phase 1 — always registered, but processOneSegmentationBatch()
    // itself no-ops on every tick until LearningSettings.conversationLearningEnabled is turned
    // on, so this has zero effect on a fresh/default install.
    startSessionSegmentationProcessor(),
    startPatternDetectionProcessor(),
    startAiAnalysisProcessor(),
    startGroupKnowledgeProcessor(),
    startKnowledgeImportProcessor(),
    // Learns how the team writes. No-ops every tick until an admin turns it on.
    startCommunicationStyleProcessor(),
    // AI Sandbox — answers test messages an admin typed in the dashboard. Entirely isolated:
    // it sends nothing, notifies nobody, and writes no production record (see sandboxJob.ts).
    // No-ops every tick unless somebody is actually using the sandbox.
    startSandboxProcessor(),
    // Knowledge Builder's on-demand "Learn from Conversations". Reads the groups an admin
    // selected and proposes candidates; never writes the scheduled builder's watermark and never
    // creates a knowledge entry on its own. No-ops every tick unless a run is queued.
    startConversationAnalysisProcessor(),
    // Softify Forge — learns ISPDIGITAL's own documentation and modules into the knowledge base.
    // Registered unconditionally; both loops return immediately unless FORGE_API_KEY/FORGE_API_URL
    // are set AND an admin enabled the integration, same convention as Conversation Learning above.
    startForgeKnowledgeProcessor(),
    startForgeResearchProcessor(),
    startCommandProcessor(registry),
    startNotificationDispatcher({
      TEAMS: new TeamsProvider(),
      WHATSAPP: new WhatsAppNotificationProvider(registry),
    }),
    // `immediate` so accounts still start connecting at once rather than on the first 20s tick —
    // the change is that they do it beside every other loop instead of in front of them.
    startAccountRegistrySync(registry, undefined, { immediate: true }),
    // Releases queue rows claimed by something that then went away. Boot-time recovery alone
    // assumed only a dead process can strand one; a hung send on a live worker does it too, and
    // that row then waits for the next restart.
    startStuckWorkRecoveryProcessor(),
    // Finishes messages stored but never processed — the window between the dedup-guard insert and
    // the status settle, which every crash and every mid-pipeline rejection lands in.
    startMessageRecoveryProcessor(),
    // Detects the failure with no symptom: CONNECTED, heartbeating, and collecting nothing.
    startCollectionWatchdog(registry),
    startHeartbeat(state, registry),
  ];

  const shutdown = makeShutdownHandler(intervals, registry, healthServer);
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

/**
 * Liveness of this process, stamped onto every account.
 *
 * Overlap-guarded like every other loop: the callback awaits a database round trip, and
 * `setInterval` does not wait for it, so a database that has become slow would otherwise stack one
 * connectivity check on top of another every fifteen seconds — turning a slow database into a
 * connection-exhausted one.
 */
function startHeartbeat(state: WorkerHealthState, registry: ProviderRegistry): NodeJS.Timeout {
  registerLoop("heartbeat", HEARTBEAT_INTERVAL_MS);
  let beating = false;
  return setInterval(() => {
    if (beating) return;
    beating = true;
    void (async () => {
      state.lastHeartbeatAt = Date.now();
      const connected = await checkDatabaseConnection();
      console.log(`[worker] heartbeat db=${connected ? "connected" : "unreachable"}`);

      // Stamp every account so the dashboard can tell "the worker is down" apart from "the
      // worker is up but this account will not connect" — two situations that need completely
      // different responses and looked identical before.
      //
      // This column used to be written only by recordConnectionState(), i.e. only when a
      // session's state actually changed, which made a healthy worker with a stable account
      // look silent for hours. Whether a given session is alive is what `status` is for; this
      // is liveness of the process that manages them.
      if (connected) {
        // Narrowed to the accounts this process actually holds, plus any whose stamp is genuinely
        // stale. A bare `updateMany({ data })` has no WHERE at all, so it rewrote EVERY account row
        // — including retired spares and numbers nobody has linked — 5,760 times a day. Each rewrite
        // is a new tuple, an index update and a dead row for the vacuum to collect, to express one
        // fact: this process is alive.
        //
        // It stays an updateMany rather than a per-account loop because the stamp has to land on
        // every account the dashboard might be looking at, and one statement is one round trip.
        const heldAccountIds = registry.allAccountIds();
        await platformPrisma.whatsAppAccount
          .updateMany({
            where: {
              OR: [
                { id: { in: heldAccountIds } },
                // An account this process does NOT hold still needs its stamp kept fresh, or the
                // dashboard reads "the worker is down" from a number that is merely not connected.
                // Once a minute is enough for a 60-second staleness threshold.
                { lastHeartbeatAt: null },
                { lastHeartbeatAt: { lt: new Date(Date.now() - 45_000) } },
              ],
            },
            data: { lastHeartbeatAt: new Date() },
          })
          .catch((err) => console.error("[worker] heartbeat stamp failed", err));

        // Publish what every OTHER loop was last seen doing, so "the worker is alive" stops
        // meaning "this one timer fires". Written here rather than by each loop because the
        // command processor ticks every 1.5s, and a write per tick would be tens of thousands of
        // rows a day to report that nothing is wrong. One row, one upsert, fifteen seconds.
        await platformPrisma.workerHealthSnapshot
          .upsert({
            where: { id: "global" },
            update: { loops: (readLoops() as unknown as Prisma.InputJsonValue), startedAt: new Date(state.startedAt) },
            create: { id: "global", loops: (readLoops() as unknown as Prisma.InputJsonValue), startedAt: new Date(state.startedAt) },
          })
          .catch((err) => console.error("[worker] loop-liveness snapshot failed", err));
      }
    })()
      .catch((err) => console.error("[worker] heartbeat failed", err))
      .finally(() => {
        beating = false;
        recordLoopTick("heartbeat", HEARTBEAT_INTERVAL_MS);
      });
  }, HEARTBEAT_INTERVAL_MS);
}

/**
 * Stops taking new work, lets what is already running finish, then goes.
 *
 * Two things were missing and both produce the same visible symptom — a customer receiving the
 * same reply twice. `clearInterval` only cancels the NEXT tick, so the one already awaiting
 * `sendText` was previously killed with the process: WhatsApp may or may not have received it, and
 * the row stayed PROCESSING until the next boot pushed it back to PENDING and sent it again. And
 * the handler was not re-entrant, so a second SIGTERM (an impatient `docker stop`, or SIGINT after
 * SIGTERM) ran the whole teardown a second time on top of the first.
 *
 * `beginShutdown()` is what actually stops new claims — a tick already scheduled still fires after
 * its interval is cleared, and `trackTick` turns it into a no-op.
 */
function makeShutdownHandler(
  intervals: NodeJS.Timeout[],
  registry: ProviderRegistry,
  healthServer: { close: (cb: () => void) => void },
): (signal: string) => void {
  let started = false;
  return (signal: string) => {
    if (started) {
      console.log(`[worker] received ${signal} while already shutting down — ignoring`);
      return;
    }
    started = true;
    console.log(`[worker] received ${signal}, shutting down`);

    beginShutdown();
    intervals.forEach(clearInterval);

    void (async () => {
      const settled = await awaitQuiescence(SHUTDOWN_GRACE_MS);
      console.log(
        settled
          ? "[worker] in-flight work finished — closing sessions"
          : `[worker] in-flight work did not finish within ${SHUTDOWN_GRACE_MS}ms — closing sessions anyway`,
      );
      await registry.disconnectAll().catch(() => undefined);
      healthServer.close(() => process.exit(0));
      // A socket the health check happens to be holding open must not keep the container alive.
      setTimeout(() => process.exit(0), 5_000).unref();
    })();
  };
}

main().catch((err) => {
  console.error("[worker] fatal startup error", err);
  process.exit(1);
});
