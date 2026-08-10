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
