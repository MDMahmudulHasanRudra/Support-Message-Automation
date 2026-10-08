import type { PrismaClient } from "@support-automation/db";
import type { AiCallOutcome } from "./types.js";

/**
 * Real AI calls, not just the manual Test Connection button, decide what the dashboard says about
 * a provider. Before this, `lastTestOk` moved only when someone pressed Test, so a provider that
 * had been 401-ing in production for a week still showed a green OK badge — the one screen an
 * admin would look at was the one screen that could not know.
 *
 * No new table (and so no migration): the existing lastTested* columns become "the last definitive
 * verdict on these credentials and this model", from whichever source produced it, and the
 * providers page labels them that way.
 *
 * A transient failure — a rate limit, a provider outage, a dropped connection — deliberately does
 * NOT flip the badge to red. It says nothing about whether the key or the model id is right, and
 * showing a config-failure colour for a blip that cleared by itself would teach admins to ignore
 * the badge. Those land in SystemLog instead, which the providers page reads as a recent-issues
 * count so they stay visible without being mislabelled.
 */

/** Scope used for every provider-health entry, so the providers page and /logs can both find them. */
export const PROVIDER_HEALTH_LOG_SCOPE = "ai-provider";

/** A healthy provider would otherwise write a row per message; once every few minutes is plenty. */
const SUCCESS_REFRESH_MS = 5 * 60_000;

const lastWrite = new Map<string, { at: number; ok: boolean }>();

/**
 * Fire-and-forget by design: this describes a call that has already happened, and must never
 * change that call's own outcome or add latency to a message's pipeline pass.
 */
export function reportProviderCallOutcome(db: PrismaClient, providerId: string, outcome: AiCallOutcome): void {
  void persist(db, providerId, outcome).catch((err) => {
    console.error("[ai-client] failed to record provider health", err);
  });
}

async function persist(db: PrismaClient, providerId: string, outcome: AiCallOutcome): Promise<void> {
  if (outcome.ok) {
    const previous = lastWrite.get(providerId);
    const stale = !previous || !previous.ok || Date.now() - previous.at > SUCCESS_REFRESH_MS;
    if (!stale) return;
    lastWrite.set(providerId, { at: Date.now(), ok: true });
    await db.aiProvider.update({
      where: { id: providerId },
      data: { lastTestedAt: new Date(), lastTestOk: true, lastTestError: null },
    });
    return;
  }

  if (outcome.transient) {
    await logProviderEvent(db, "WARN", providerId, `AI call failed temporarily: ${outcome.message}`, { transient: true });
    return;
  }

  lastWrite.set(providerId, { at: Date.now(), ok: false });
  await db.aiProvider.update({
    where: { id: providerId },
    data: { lastTestedAt: new Date(), lastTestOk: false, lastTestError: outcome.message },
  });
  await logProviderEvent(db, "WARN", providerId, `AI call failed: ${outcome.message}`, { transient: false });
}

async function logProviderEvent(
  db: PrismaClient,
  level: "WARN",
  providerId: string,
  message: string,
  extra: Record<string, unknown>,
): Promise<void> {
  try {
    await db.systemLog.create({
      data: {
        level,
        scope: PROVIDER_HEALTH_LOG_SCOPE,
        message,
        metadata: { providerId, ...extra },
      },
    });
  } catch (err) {
    console.error("[ai-client] failed to persist provider health log", err);
  }
}
