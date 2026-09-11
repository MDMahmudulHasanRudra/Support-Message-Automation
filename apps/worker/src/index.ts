import { checkDatabaseConnection, prisma } from "@support-automation/db";
import { startHealthServer, type WorkerHealthState } from "./health/server.js";
import { ProviderRegistry } from "./provider/ProviderRegistry.js";
import { ensureLegacyAccountExists, ensurePrimaryAccountExists, findConnectableAccounts } from "./provider/accountProvisioning.js";
import { startAccountRegistrySync } from "./provider/accountRegistrySync.js";
import { startOutboundQueueProcessor } from "./queue/outboundQueueProcessor.js";
import { startGroupParticipantAddProcessor } from "./queue/groupParticipantAddProcessor.js";
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
import { logSystemEvent } from "./logging/logSystemEvent.js";
import { startEscalationProcessor } from "./escalation/escalationProcessor.js";
import { startSessionSegmentationProcessor } from "./learning/sessionSegmentationProcessor.js";
import { startPatternDetectionProcessor } from "./learning/patternDetectionProcessor.js";
import { startAiAnalysisProcessor } from "./learning/aiAnalysisProcessor.js";
import { startGroupKnowledgeProcessor } from "./knowledge/groupKnowledgeProcessor.js";
import { startKnowledgeImportProcessor } from "./knowledge/knowledgeImportProcessor.js";
import { startCommunicationStyleProcessor } from "./knowledge/communicationStyleProcessor.js";
import { startTeamsSyncProcessor, resolveTeamsSyncIntervalMs } from "./teams/teamsSyncProcessor.js";
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

  const recovered = await runStuckWorkRecovery();
  if (recovered.outbound + recovered.notifications + recovered.participantAdds + recovered.commands > 0) {
    console.log(
      `[worker] crash recovery: requeued ${recovered.outbound} outbound message(s), ${recovered.notifications} notification(s), ${recovered.participantAdds} group-participant-add item(s); failed ${recovered.commands} interrupted worker command(s)`,
    );
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

  // Every known, already-session-provisioned account is connected SEQUENTIALLY at startup —
  // never concurrently (see ProviderRegistry's class doc comment on why connect() calls must
  // never race each other). On a worker restart this reconnects every account that was live
  // before the process died, not just the legacy one.
  const accountsToConnect = await findConnectableAccounts();
  console.log(`[worker] connecting ${accountsToConnect.length} account(s): ${accountsToConnect.map((a) => a.label).join(", ")}`);
  await logSystemEvent("INFO", "worker", "Worker starting up", {
    accountIds: accountsToConnect.map((a) => a.id),
    legacyAccountId: legacyAccount.id,
  });

  for (const account of accountsToConnect) {
    if (!account.sessionId || !account.sessionDataPath) continue; // defensive; findConnectableAccounts already filters this
    await registry.connectAccount({ id: account.id, sessionId: account.sessionId, sessionDataPath: account.sessionDataPath });
  }

  const intervals: NodeJS.Timeout[] = [
    startOutboundQueueProcessor(registry),
    startGroupParticipantAddProcessor(registry),
    startEscalationProcessor(),
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
    // Microsoft Teams Integration — polling sync, always registered but a no-op every tick until
    // MICROSOFT_CLIENT_ID/SECRET/TENANT_ID/REDIRECT_URI are configured AND an admin completes the
    // OAuth connect flow (see getValidTeamsAccessToken()'s doc comment), same zero-effect-until-
    // configured convention as Conversation Learning above.
    startTeamsSyncProcessor(await resolveTeamsSyncIntervalMs()),
    // Softify Forge — learns ISPDIGITAL's own documentation and modules into the knowledge base.
    // Registered unconditionally; both loops return immediately unless FORGE_API_KEY/FORGE_API_URL
    // are set AND an admin enabled the integration, same convention as Teams above.
    startForgeKnowledgeProcessor(),
    startForgeResearchProcessor(),
    startCommandProcessor(registry),
    startNotificationDispatcher({
      TEAMS: new TeamsProvider(),
      WHATSAPP: new WhatsAppNotificationProvider(registry),
    }),
    startAccountRegistrySync(registry),
    // Releases queue rows claimed by something that then went away. Boot-time recovery alone
    // assumed only a dead process can strand one; a hung send on a live worker does it too, and
    // that row then waits for the next restart.
    startStuckWorkRecoveryProcessor(),
    // Finishes messages stored but never processed — the window between the dedup-guard insert and
    // the status settle, which every crash and every mid-pipeline rejection lands in.
    startMessageRecoveryProcessor(),
    // Detects the failure with no symptom: CONNECTED, heartbeating, and collecting nothing.
    startCollectionWatchdog(registry),
    startHeartbeat(state),
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
function startHeartbeat(state: WorkerHealthState): NodeJS.Timeout {
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
        await prisma.whatsAppAccount
          .updateMany({ data: { lastHeartbeatAt: new Date() } })
          .catch((err) => console.error("[worker] heartbeat stamp failed", err));
      }
    })()
      .catch((err) => console.error("[worker] heartbeat failed", err))
      .finally(() => {
        beating = false;
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
