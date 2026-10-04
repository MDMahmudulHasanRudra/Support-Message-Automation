import { computeDataHealth, type DataHealth } from "@support-automation/shared";
import { prisma } from "@/server/db";

/**
 * Reporting data health for one report period (packages/shared/src/dataHealth.ts decides; this only
 * reads). Everything goes through the scoped client, so one project's gaps never appear in another's
 * report.
 *
 * Only accounts in at least one group count: a spare number in no group cannot lose a group message,
 * and its every reconnect would otherwise mark every report incomplete.
 */

export interface ReportDataHealth extends DataHealth {
  /** The newest stored message's WhatsApp time — the "last message received" a reader checks first. */
  lastMessageAt: number | null;
  /** The newest checkpoint write: when the worker last processed anything. */
  lastProcessedAt: number | null;
}

const MAX_GAPS = 200;

export async function loadDataHealth(input: { periodStart: number; periodEnd: number; now: Date; accountId?: string | null }): Promise<ReportDataHealth> {
  const { periodStart, periodEnd, now, accountId } = input;
  const accountWhere = accountId ? { accountId } : {};
  const [settings, gaps, newest, checkpoint] = await Promise.all([
    prisma.supportActivitySettings.findFirst({ select: { reportingVerifiedFrom: true } }),
    prisma.collectionGap.findMany({
      where: {
        ...accountWhere,
        startedAt: { lt: new Date(periodEnd) },
        OR: [{ endedAt: null }, { endedAt: { gt: new Date(periodStart) } }],
        account: { groups: { some: {} } },
      },
      orderBy: { startedAt: "asc" },
      take: MAX_GAPS,
      select: {
        accountId: true,
        cause: true,
        startedAt: true,
        endedAt: true,
        recoveryStatus: true,
        recoveredCount: true,
        recoveryNote: true,
        account: { select: { label: true } },
      },
    }),
    prisma.message.findFirst({ where: accountWhere, orderBy: { timestampWa: "desc" }, select: { timestampWa: true } }),
    prisma.processingCheckpoint.findFirst({ where: accountWhere, orderBy: { updatedAt: "desc" }, select: { updatedAt: true } }),
  ]);

  const health = computeDataHealth({
    periodStart,
    periodEnd,
    now: now.getTime(),
    verifiedFrom: settings?.reportingVerifiedFrom?.getTime() ?? null,
    gaps: gaps.map((g) => ({
      accountId: g.accountId,
      accountLabel: g.account.label,
      cause: g.cause,
      startedAt: g.startedAt.getTime(),
      endedAt: g.endedAt?.getTime() ?? null,
      recoveryStatus: g.recoveryStatus,
      recoveredCount: g.recoveredCount,
      recoveryNote: g.recoveryNote,
    })),
  });
  return { ...health, lastMessageAt: newest?.timestampWa.getTime() ?? null, lastProcessedAt: checkpoint?.updatedAt.getTime() ?? null };
}

/** The accounts each WhatsApp group is stored under, for per-group data confidence. */
export async function accountsByGroupKey(groupKeys: readonly string[]): Promise<Map<string, string[]>> {
  if (groupKeys.length === 0) return new Map();
  const rows = await prisma.whatsAppGroup.findMany({ where: { whatsappGroupId: { in: [...groupKeys] } }, select: { whatsappGroupId: true, accountId: true } });
  const out = new Map<string, string[]>();
  for (const row of rows) out.set(row.whatsappGroupId, [...(out.get(row.whatsappGroupId) ?? []), row.accountId]);
  return out;
}
