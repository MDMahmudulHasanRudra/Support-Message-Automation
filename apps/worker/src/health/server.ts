import { createServer } from "node:http";
import { checkDatabaseConnection } from "@support-automation/db";
import { readMetrics } from "./metrics.js";

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
 *
 * Two routes, and the difference is what each is FOR. `/health` answers "should this container be
 * restarted", and `/metrics` answers "what has this process actually done" — a question you ask
 * over `docker compose exec` when something looks wrong, not one an orchestrator should act on.
 */
export function startHealthServer(state: WorkerHealthState, port: number) {
  const server = createServer((req, res) => {
    if (req.url === "/metrics") {
      respond(res, 200, { uptimeMs: Date.now() - state.startedAt, ...readMetrics() });
      return;
    }

    if (req.url !== "/health") {
      res.writeHead(404).end();
      return;
    }

    void checkDatabaseConnection().then((dbConnected) => {
      const sinceHeartbeatMs = Date.now() - state.lastHeartbeatAt;
      respond(res, dbConnected ? 200 : 503, {
        status: dbConnected ? "ok" : "degraded",
        dbConnected,
        uptimeMs: Date.now() - state.startedAt,
        lastHeartbeatAt: new Date(state.lastHeartbeatAt).toISOString(),
        sinceHeartbeatMs,
        // Reported, deliberately NOT part of the 200/503 decision. Restarting the container cannot
        // fix an unscanned QR, a number WhatsApp has logged out, or a session waiting on a human —
        // it would just cycle Chromium against a problem only a person with the phone can solve,
        // and lose every healthy session alongside it. The database is the one dependency where a
        // restart is the right response, so it alone decides the code.
        metrics: readMetrics(),
      });
    });
  });

  server.listen(port, "127.0.0.1");
  return server;
}

function respond(res: import("node:http").ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
