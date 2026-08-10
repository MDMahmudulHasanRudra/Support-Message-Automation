import { createServer } from "node:http";
import { checkDatabaseConnection } from "@support-automation/db";

export interface WorkerHealthState {
  startedAt: number;
  lastHeartbeatAt: number;
}

/**
 * Loopback-only health endpoint consumed exclusively by this container's
 * own Docker HEALTHCHECK instruction. It is never published via
 * docker-compose `ports`, so it stays unreachable from the host or the
 * `app` service — the worker keeps no externally reachable port, per the
 * locked architecture (dashboard <-> worker communicate only through
 * Postgres, never HTTP).
 */
export function startHealthServer(state: WorkerHealthState, port: number) {
  const server = createServer((req, res) => {
    if (req.url !== "/health") {
      res.writeHead(404).end();
      return;
    }

    void checkDatabaseConnection().then((dbConnected) => {
      const body = JSON.stringify({
        status: dbConnected ? "ok" : "degraded",
        dbConnected,
        uptimeMs: Date.now() - state.startedAt,
        lastHeartbeatAt: new Date(state.lastHeartbeatAt).toISOString(),
      });
      res.writeHead(dbConnected ? 200 : 503, {
        "Content-Type": "application/json",
      });
      res.end(body);
    });
  });

  server.listen(port, "127.0.0.1");
  return server;
}
