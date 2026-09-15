import { prisma } from "@support-automation/db";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

async function countSent(accountId: string, sinceMs: number, toPhone?: string): Promise<number> {
  return prisma.outboundMessage.count({
    where: {
      accountId,
      status: "SENT",
      sentAt: { gte: new Date(Date.now() - sinceMs) },
      ...(toPhone ? { toPhone } : {}),
    },
  });
}

/**
 * Whether a usage count has reached its configured ceiling.
 *
 * A limit of 0 means ZERO SENDS ALLOWED, not "unlimited". That is the literal reading, and it is
 * the meaning the integration suite has encoded in three separate files for as long as they have
 * existed (`pipeline.integration.test.ts`'s "limit is already zero", `testModeGroup`'s throttled
 * fixture, `aiFallback`'s rate-limit-exhausted case all set a limit to 0 to mean blocked).
 *
 * This was briefly changed to treat 0 as "no limit", to stop a cleared Settings box silently
 * halting every outbound message with the self-refuting "limit reached (0/0)". That accident is
 * real, but it is now prevented at its actual source — `updateSafetySettings` keeps the current
 * value for an empty field rather than writing 0 — so redefining a deliberately typed 0 is not
 * needed to fix it, and redefining a rate limit that protects a bannable WhatsApp number is not a
 * change to make against a suite that says otherwise.
 *
 * The helper stays, even though it is now one comparison, because both the enqueue-time gate
 * (pipeline/safety.ts) and the send-time re-check (queue/outboundQueueProcessor.ts) call it. Two
 * hand-written copies of this rule is exactly the drift this codebase keeps getting bitten by.
 */
export function exceedsLimit(used: number, limit: number): boolean {
  if (!Number.isFinite(limit)) return false;
  return used >= limit;
}

export interface GlobalRateLimitUsage {
  perMinute: number;
  perHour: number;
  perDay: number;
}

export async function getGlobalRateLimitUsage(accountId: string): Promise<GlobalRateLimitUsage> {
  const [perMinute, perHour, perDay] = await Promise.all([
    countSent(accountId, MINUTE_MS),
    countSent(accountId, HOUR_MS),
    countSent(accountId, DAY_MS),
  ]);
  return { perMinute, perHour, perDay };
}

export interface PerClientLimitUsage {
  perHour: number;
  perDay: number;
}

export async function getPerClientLimitUsage(
  accountId: string,
  toPhone: string,
): Promise<PerClientLimitUsage> {
  const [perHour, perDay] = await Promise.all([
    countSent(accountId, HOUR_MS, toPhone),
    countSent(accountId, DAY_MS, toPhone),
  ]);
  return { perHour, perDay };
}
