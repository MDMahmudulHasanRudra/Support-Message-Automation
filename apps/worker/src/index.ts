import { checkDatabaseConnection } from "@support-automation/db";
import { startHealthServer, type WorkerHealthState } from "./health/server.js";

// Phase 1 scope only: prove the worker process boots, reaches Postgres, and
// reports health inside Docker. OpenWA connection, the message pipeline, the
// outbound queue, and the WorkerCommand poller land in later phases.

const HEALTH_PORT = Number(process.env.WORKER_HEALTH_PORT ?? 4100);
const HEARTBEAT_INTERVAL_MS = 15_000;

async function main() {
  const state: WorkerHealthState = {
    startedAt: Date.now(),
    lastHeartbeatAt: Date.now(),
  };

  const healthServer = startHealthServer(state, HEALTH_PORT);
  console.log(`[worker] health server listening on 127.0.0.1:${HEALTH_PORT}`);

  const heartbeat = setInterval(async () => {
    state.lastHeartbeatAt = Date.now();
    const dbConnected = await checkDatabaseConnection();
    console.log(
      `[worker] heartbeat db=${dbConnected ? "connected" : "unreachable"}`,
    );
  }, HEARTBEAT_INTERVAL_MS);

  const shutdown = (signal: string) => {
    console.log(`[worker] received ${signal}, shutting down`);
    clearInterval(heartbeat);
    healthServer.close(() => process.exit(0));
    // Force-exit if close() hangs (e.g. a lingering keep-alive connection).
    setTimeout(() => process.exit(0), 5_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  const dbConnected = await checkDatabaseConnection();
  console.log(
    `[worker] started, db=${dbConnected ? "connected" : "unreachable"}`,
  );
}

main().catch((err) => {
  console.error("[worker] fatal startup error", err);
  process.exit(1);
});
