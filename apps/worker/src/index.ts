import { checkDatabaseConnection } from "@support-automation/db";
import { startHealthServer, type WorkerHealthState } from "./health/server.js";
import { ProviderRegistry } from "./provider/ProviderRegistry.js";
import { ensureLegacyAccountExists, ensurePrimaryAccountExists, findConnectableAccounts } from "./provider/accountProvisioning.js";
import { startAccountRegistrySync } from "./provider/accountRegistrySync.js";
import { recoverStuckOutboundMessages, startOutboundQueueProcessor } from "./queue/outboundQueueProcessor.js";
import {
  recoverStuckParticipantAddItems,
  startGroupParticipantAddProcessor,
} from "./queue/groupParticipantAddProcessor.js";
import { recoverStuckNotifications, startNotificationDispatcher } from "./notifications/dispatcher.js";
import { TeamsProvider } from "./notifications/TeamsProvider.js";
import { WhatsAppNotificationProvider } from "./notifications/WhatsAppNotificationProvider.js";
import { startCommandProcessor } from "./commands/commandProcessor.js";
import { logSystemEvent } from "./logging/logSystemEvent.js";
import { startEscalationProcessor } from "./escalation/escalationProcessor.js";
import { startSessionSegmentationProcessor } from "./learning/sessionSegmentationProcessor.js";
import { startPatternDetectionProcessor } from "./learning/patternDetectionProcessor.js";

const HEALTH_PORT = Number(process.env.WORKER_HEALTH_PORT ?? 4100);
const HEARTBEAT_INTERVAL_MS = 15_000;

async function main() {
  const state: WorkerHealthState = { startedAt: Date.now(), lastHeartbeatAt: Date.now() };
  const healthServer = startHealthServer(state, HEALTH_PORT);
  console.log(`[worker] health server listening on 127.0.0.1:${HEALTH_PORT}`);

  const dbConnected = await checkDatabaseConnection();
  console.log(`[worker] started, db=${dbConnected ? "connected" : "unreachable"}`);
  if (!dbConnected) {
    throw new Error("Cannot start without a database connection.");
  }

  const recoveredOutbound = await recoverStuckOutboundMessages();
  const recoveredNotifications = await recoverStuckNotifications();
  const recoveredParticipantAdds = await recoverStuckParticipantAddItems();
  if (recoveredOutbound > 0 || recoveredNotifications > 0 || recoveredParticipantAdds > 0) {
    console.log(
      `[worker] crash recovery: requeued ${recoveredOutbound} outbound message(s), ${recoveredNotifications} notification(s), ${recoveredParticipantAdds} group-participant-add item(s)`,
    );
  }

  // Backward compatibility, load-bearing: this is the exact account (same sessionDataPath,
  // same sessionId) every pre-multi-account install already has — see ensureLegacyAccountExists's
  // own doc comment. It also becomes Primary automatically if this is a fresh install.
  const legacyAccount = await ensureLegacyAccountExists();
  await ensurePrimaryAccountExists();

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
    startCommandProcessor(registry),
    startNotificationDispatcher({
      TEAMS: new TeamsProvider(),
      WHATSAPP: new WhatsAppNotificationProvider(registry),
    }),
    startAccountRegistrySync(registry),
    setInterval(async () => {
      state.lastHeartbeatAt = Date.now();
      const connected = await checkDatabaseConnection();
      console.log(`[worker] heartbeat db=${connected ? "connected" : "unreachable"}`);
    }, HEARTBEAT_INTERVAL_MS),
  ];

  const shutdown = (signal: string) => {
    console.log(`[worker] received ${signal}, shutting down`);
    intervals.forEach(clearInterval);
    registry
      .disconnectAll()
      .catch(() => undefined)
      .finally(() => {
        healthServer.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 5_000).unref();
      });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[worker] fatal startup error", err);
  process.exit(1);
});
