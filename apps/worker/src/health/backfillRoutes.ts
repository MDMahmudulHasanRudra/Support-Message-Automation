import type { ProviderRegistry } from "../provider/ProviderRegistry.js";
import {
  cancelPersonalBackfill,
  parseBackfillRequest,
  readPersonalBackfill,
  startPersonalBackfill,
} from "../pipeline/personalBackfill.js";
import { registerOpsRoute, type OpsRoute } from "./server.js";

/**
 * The personal backfill's controls, on the worker's loopback-only health port
 * (PERSONAL_MESSAGES_RUNBOOK.md):
 *
 *   GET  /backfill/personal          the current or last run (counts only)
 *   POST /backfill/personal?account=<id>&from=<ISO>[&to=<ISO>][&maxChats=][&earlierPages=]
 *                                    start a DRY RUN (the default)
 *   POST /backfill/personal?...&mode=write&confirm=WRITE
 *                                    start a run that stores what it finds
 *   POST /backfill/personal/cancel   stop after the chat in progress
 */
export function personalBackfillRoute(registry: ProviderRegistry): OpsRoute {
  return (method, url) => {
    if (url.pathname === "/backfill/personal/cancel") {
      if (method !== "POST") return { code: 405, body: { error: "Use POST." } };
      return { code: 200, body: { cancelled: cancelPersonalBackfill(), run: readPersonalBackfill() } };
    }
    if (url.pathname !== "/backfill/personal") return null;
    if (method === "GET") return { code: 200, body: readPersonalBackfill() ?? { status: "NONE" } };
    if (method !== "POST") return { code: 405, body: { error: "Use GET for status, POST to start." } };
    const parsed = parseBackfillRequest(url.searchParams, new Date());
    if (!parsed.ok) return { code: 400, body: { error: parsed.error } };
    const started = startPersonalBackfill(registry, parsed.request);
    return started.ok ? { code: 202, body: started.state } : { code: 409, body: { error: started.error } };
  };
}

export function registerPersonalBackfillRoutes(registry: ProviderRegistry): void {
  registerOpsRoute(personalBackfillRoute(registry));
}
