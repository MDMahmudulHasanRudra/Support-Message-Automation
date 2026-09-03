import { prisma } from "@support-automation/db";
import type { AutomationSettings } from "@prisma/client";

/**
 * Guarantees the singleton settings row exists, defaulting to the safe configuration.
 *
 * Reads first and only upserts when the row is genuinely absent — i.e. once, on a fresh install.
 * This is the kill switch: it is re-read on every processing tick, once per incoming message and
 * up to three times per failing outbound send, and an unconditional upsert took a row lock on the
 * same single row every one of those times.
 *
 * Deliberately NOT cached or memoized with a TTL. The worker re-reads this every tick on purpose —
 * pausing automation has to take effect immediately, so serving a stale value would be a safety
 * regression, not an optimisation.
 */
export async function getAutomationSettings(): Promise<AutomationSettings> {
  const existing = await prisma.automationSettings.findUnique({ where: { id: "global" } });
  if (existing) return existing;
  return prisma.automationSettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" },
  });
}
