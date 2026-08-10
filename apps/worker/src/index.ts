import { checkDatabaseConnection, prisma } from "@support-automation/db";
import { startHealthServer, type WorkerHealthState } from "./health/server.js";
import { OpenWAProvider } from "./provider/openwa/OpenWAProvider.js";
import { processIncomingMessage } from "./pipeline/processIncomingMessage.js";
import { recoverStuckOutboundMessages, startOutboundQueueProcessor } from "./queue/outboundQueueProcessor.js";
import { recoverStuckNotifications, startNotificationDispatcher } from "./notifications/dispatcher.js";
import { TeamsProvider } from "./notifications/TeamsProvider.js";
import { WhatsAppNotificationProvider } from "./notifications/WhatsAppNotificationProvider.js";
import { startCommandProcessor, syncGroups } from "./commands/commandProcessor.js";

const HEALTH_PORT = Number(process.env.WORKER_HEALTH_PORT ?? 4100);
const HEARTBEAT_INTERVAL_MS = 15_000;
const SESSION_ID = process.env.WHATSAPP_SESSION_NAME ?? "support-automation";
const SESSION_DATA_PATH = process.env.WHATSAPP_SESSION_DIR ?? "/app/sessions";
const ACCOUNT_LABEL = process.env.WHATSAPP_ACCOUNT_LABEL ?? "Primary Account";

/** One worker owns exactly one account/session (see ARCHITECTURE.md's single-session-per-worker note). */
async function findOrCreateAccount() {
  const existing = await prisma.whatsAppAccount.findFirst({ where: { sessionDataPath: SESSION_DATA_PATH } });
  if (existing) return existing;
  return prisma.whatsAppAccount.create({
    data: { label: ACCOUNT_LABEL, sessionDataPath: SESSION_DATA_PATH, status: "DISCONNECTED" },
  });
}

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
  if (recoveredOutbound > 0 || recoveredNotifications > 0) {
    console.log(
      `[worker] crash recovery: requeued ${recoveredOutbound} outbound message(s), ${recoveredNotifications} notification(s)`,
    );
  }

  const account = await findOrCreateAccount();
  console.log(`[worker] using account ${account.id} (session "${SESSION_ID}" at ${SESSION_DATA_PATH})`);

  const provider = new OpenWAProvider(account.id, SESSION_ID, SESSION_DATA_PATH);

  try {
    await provider.connect();
    provider.subscribeToMessages((message) => {
      processIncomingMessage(message).catch((err) => {
        console.error("[worker] error processing incoming message", err);
      });
    });
    const groupCount = await syncGroups(account.id, provider);
    console.log(`[worker] synced ${groupCount} group(s)`);
  } catch (err) {
    console.error("[worker] failed to connect to WhatsApp — will remain running and retry via RECONNECT commands", err);
    await prisma.whatsAppAccount.update({ where: { id: account.id }, data: { status: "ERROR" } });
  }

  const intervals: NodeJS.Timeout[] = [
    startOutboundQueueProcessor(provider),
    startCommandProcessor(account.id, provider),
    startNotificationDispatcher({
      TEAMS: new TeamsProvider(),
      WHATSAPP: new WhatsAppNotificationProvider(provider),
    }),
    setInterval(async () => {
      state.lastHeartbeatAt = Date.now();
      const connected = await checkDatabaseConnection();
      console.log(`[worker] heartbeat db=${connected ? "connected" : "unreachable"}`);
    }, HEARTBEAT_INTERVAL_MS),
  ];

  const shutdown = (signal: string) => {
    console.log(`[worker] received ${signal}, shutting down`);
    intervals.forEach(clearInterval);
    provider
      .disconnect()
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
