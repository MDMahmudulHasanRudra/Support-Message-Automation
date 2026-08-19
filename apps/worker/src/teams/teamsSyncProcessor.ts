import { prisma } from "@support-automation/db";
import { runTeamsSync } from "./graphSync.js";

const DEFAULT_INTERVAL_MS = 3 * 60_000;

/**
 * Starts the periodic Teams sync loop — polling, not a webhook (see TEAMS_SETUP.md for why a
 * real-time subscription is deferred). Same overlap-guarded setInterval pattern as every other
 * background loop in this worker (ENGINEERING_STANDARDS.md §9): a slow Graph API round trip must
 * never let a second tick start a concurrent sync. A Teams API failure is caught entirely inside
 * runTeamsSync() and logged — it must never affect WhatsApp message processing, which shares
 * nothing with this loop.
 */
export function startTeamsSyncProcessor(intervalMs = DEFAULT_INTERVAL_MS): NodeJS.Timeout {
  let processing = false;
  return setInterval(() => {
    if (processing) return;
    processing = true;
    runTeamsSync()
      .catch((err) => {
        console.error("[teams] unexpected error during Teams sync", err);
      })
      .finally(() => {
        processing = false;
      });
  }, intervalMs);
}

/** Resolves the admin-configured polling interval, falling back to the default when Teams
 * integration settings haven't been created yet (lazy singleton, same convention as every other
 * settings model). Read once at startup — changing it takes effect on the next worker restart,
 * same as every other interval in apps/worker/src/index.ts. */
export async function resolveTeamsSyncIntervalMs(): Promise<number> {
  const settings = await prisma.teamsIntegrationSettings.findUnique({ where: { id: "global" } });
  const minutes = settings?.pollingIntervalMinutes;
  return minutes && minutes > 0 ? minutes * 60_000 : DEFAULT_INTERVAL_MS;
}
