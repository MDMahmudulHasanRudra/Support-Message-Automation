import { Prisma, prisma } from "@support-automation/db";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Every window in one pass over the widest one.
 *
 * There were five separate `COUNT(*)`s per outbound send — three global, two per-client — and the
 * two per-day ones each scanned a full day of SENT rows for the account. Since the minute and hour
 * windows are strict subsets of the day, all of it is answerable from a single scan with
 * conditional aggregation: the index range is read once instead of three times, per message, on
 * the hot send path.
 *
 * Identical results, with one incidental improvement: the windows are now measured from ONE
 * instant rather than from three captured microseconds apart, so the counts are guaranteed
 * consistent with each other rather than merely almost.
 */
async function countSentWindows(
  accountId: string,
  windowsMs: readonly number[],
  toPhone?: string,
): Promise<number[]> {
  const now = Date.now();
  const widest = Math.max(...windowsMs);
  const rows = await prisma.$queryRaw<Array<Record<string, bigint>>>`
    SELECT
      COUNT(*) FILTER (WHERE o."sentAt" >= ${new Date(now - (windowsMs[0] ?? widest))}) AS w0,
      COUNT(*) FILTER (WHERE o."sentAt" >= ${new Date(now - (windowsMs[1] ?? widest))}) AS w1,
      COUNT(*) FILTER (WHERE o."sentAt" >= ${new Date(now - (windowsMs[2] ?? widest))}) AS w2
    FROM "OutboundMessage" o
    WHERE o."accountId" = ${accountId}
      AND o."status" = 'SENT'::"OutboundMessageStatus"
      AND o."sentAt" >= ${new Date(now - widest)}
      ${toPhone ? Prisma.sql`AND o."toPhone" = ${toPhone}` : Prisma.empty}
  `;
  const row = rows[0];
  return windowsMs.map((_, index) => Number(row?.[`w${index}`] ?? 0));
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
  const [perMinute, perHour, perDay] = await countSentWindows(accountId, [MINUTE_MS, HOUR_MS, DAY_MS]);
  return { perMinute: perMinute!, perHour: perHour!, perDay: perDay! };
}

export interface PerClientLimitUsage {
  perHour: number;
  perDay: number;
}

export async function getPerClientLimitUsage(
  accountId: string,
  toPhone: string,
): Promise<PerClientLimitUsage> {
  // Two windows, so the third slot in the query repeats the widest one and is discarded — one
  // statement shape is easier to keep correct than two nearly-identical ones.
  const [perHour, perDay] = await countSentWindows(accountId, [HOUR_MS, DAY_MS], toPhone);
  return { perHour: perHour!, perDay: perDay! };
}
