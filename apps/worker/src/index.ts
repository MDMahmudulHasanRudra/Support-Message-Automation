import { checkDatabaseConnection, prisma } from "@support-automation/db";
import { startHealthServer, type WorkerHealthState } from "./health/server.js";
import { OpenWAProvider } from "./provider/openwa/OpenWAProvider.js";
import { processIncomingMessage } from "./pipeline/processIncomingMessage.js";
import { recoverStuckOutboundMessages, startOutboundQueueProcessor } from "./queue/outboundQueueProcessor.js";
import {
  recoverStuckParticipantAddItems,
  startGroupParticipantAddProcessor,
} from "./queue/groupParticipantAddProcessor.js";
import { recoverStuckNotifications, startNotificationDispatcher } from "./notifications/dispatcher.js";
import { TeamsProvider } from "./notifications/TeamsProvider.js";
import { WhatsAppNotificationProvider } from "./notifications/WhatsAppNotificationProvider.js";
import { startCommandProcessor, syncGroupsWithTimeoutAndRetry } from "./commands/commandProcessor.js";
import { logSystemEvent } from "./logging/logSystemEvent.js";
import { startEscalationProcessor } from "./escalation/escalationProcessor.js";

const HEALTH_PORT = Number(process.env.WORKER_HEALTH_PORT ?? 4100);
const HEARTBEAT_INTERVAL_MS = 15_000;
const SESSION_ID = process.env.WHATSAPP_SESSION_NAME ?? "support-automation";
const SESSION_DATA_PATH = process.env.WHATSAPP_SESSION_DIR ?? "/app/sessions";
const ACCOUNT_LABEL = process.env.WHATSAPP_ACCOUNT_LABEL ?? "Primary Account";

const CONNECT_RETRY_DELAYS_MS = [15_000, 45_000]; // bounded, matching the spec's "safe retry policy" spirit — not unlimited

/**
 * A single transient failure (e.g. WhatsApp Web taking longer than usual to
 * bootstrap) shouldn't require a manual RECONNECT command. Bounded retries
 * only — after these are exhausted, the account is left in ERROR and a
 * manual RECONNECT (or a worker restart) is required, same as before.
 */
async function connectWithRetry(provider: OpenWAProvider, accountId: string): Promise<boolean> {
  const attempts = CONNECT_RETRY_DELAYS_MS.length + 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await provider.connect();
      return true;
    } catch (err) {
      const isLastAttempt = attempt === attempts;
      console.error(
        `[worker] connect attempt ${attempt}/${attempts} failed${isLastAttempt ? "" : " — will retry"}`,
        err,
      );
      await logSystemEvent("ERROR", "provider", `Connect attempt ${attempt}/${attempts} failed`, {
        error: (err as Error).message,
      });
      if (isLastAttempt) return false;
      await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_DELAYS_MS[attempt - 1]));
    }
  }
  return false;
}

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
  const recoveredParticipantAdds = await recoverStuckParticipantAddItems();
  if (recoveredOutbound > 0 || recoveredNotifications > 0 || recoveredParticipantAdds > 0) {
    console.log(
      `[worker] crash recovery: requeued ${recoveredOutbound} outbound message(s), ${recoveredNotifications} notification(s), ${recoveredParticipantAdds} group-participant-add item(s)`,
    );
  }

  const account = await findOrCreateAccount();
  console.log(`[worker] using account ${account.id} (session "${SESSION_ID}" at ${SESSION_DATA_PATH})`);
  await logSystemEvent("INFO", "worker", "Worker starting up", { accountId: account.id, sessionId: SESSION_ID });

  const provider = new OpenWAProvider(account.id, SESSION_ID, SESSION_DATA_PATH);

  const connected = await connectWithRetry(provider, account.id);
  if (connected) {
    provider.subscribeToMessages((message) => {
      // PHASE 6.1: the exact OpenWA -> worker event handoff point — logged
      // here, not inside the provider, since this is the provider-agnostic
      // boundary (per WhatsAppProvider.ts's own doc comment) that any future
      // provider implementation would call through identically.
      console.log(
        `[pipeline] [${message.accountId}:${message.whatsappMessageId}] MESSAGE_RECEIVED`,
        JSON.stringify({
          chatId: message.chatId,
          senderPhone: message.senderPhone,
          direction: message.direction,
          isGroup: Boolean(message.whatsappGroupId),
        }),
      );
      processIncomingMessage(message).catch((err) => {
        console.error("[worker] error processing incoming message", err);
        logSystemEvent("ERROR", "pipeline", "Error processing incoming message", { error: (err as Error).message });
      });
    });
    // PHASE 5.2: deliberately NOT awaited. A slow/failed group sync (see
    // commandProcessor.ts's confirmed root-cause comment) must never delay
    // message processing — already wired above — or the startup of the
    // outbound queue/command/notification loops below, and it must never be
    // able to crash the worker the way an unguarded `await` here once did.
    syncGroupsWithTimeoutAndRetry(account.id, provider)
      .then((groupCount) => {
        console.log(`[worker] synced ${groupCount} group(s)`);
      })
      .catch((err) => {
        console.error("[worker] group sync failed after retries — WhatsApp connection remains active", err);
      });
  } else {
    console.error(
      "[worker] failed to connect to WhatsApp after all retries — will remain running; use the dashboard's Reconnect action to try again",
    );
    await logSystemEvent("ERROR", "provider", "Failed to connect to WhatsApp after all retries", {});
  }

  const intervals: NodeJS.Timeout[] = [
    startOutboundQueueProcessor(provider),
    startGroupParticipantAddProcessor(provider),
    startEscalationProcessor(),
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
