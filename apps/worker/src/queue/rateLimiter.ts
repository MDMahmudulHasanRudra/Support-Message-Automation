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
 * Whether a usage count has reached its configured ceiling — with 0 (or any non-positive value)
 * meaning NO LIMIT rather than "block everything".
 *
 * The distinction is the whole reason this helper exists. Written inline as `used >= limit`, a
 * limit of 0 makes `0 >= 0` true and blocks every outbound message forever, reporting the
 * self-refuting "limit reached (0/0)". That is reachable from the Settings form with one cleared
 * box, and it silences rule replies and AI replies together.
 *
 * Both the enqueue-time gate (pipeline/safety.ts) and the send-time re-check
 * (queue/outboundQueueProcessor.ts) import this rather than restating the comparison, so the two
 * cannot disagree about what a limit of 0 means — this codebase has been bitten before by a
 * second copy of a rule drifting from the first.
 */
export function exceedsLimit(used: number, limit: number): boolean {
  if (!Number.isFinite(limit) || limit <= 0) return false;
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
