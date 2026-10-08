import { Prisma, type CollectionGapRecovery } from "@prisma/client";
import { platformPrisma, prisma } from "../db.js";
import { currentProjectId } from "../project/context.js";

/**
 * Collection gaps (SUPPORT_INTELLIGENCE_IMPLEMENTATION_AUDIT.md §H): the durable record of every
 * period a WhatsApp account was not collecting messages, and of what the catch-up sweep recovered
 * afterwards. Reports read it to say "reporting data may be incomplete between 14:20 and 15:05"
 * rather than calling a quiet group inactive.
 *
 * Every function here is best-effort and never throws. A gap that fails to be recorded is a
 * reporting caveat lost; a connection-state write or a catch-up sweep broken by it would be an
 * outage, which is the thing being recorded.
 *
 * One open gap per account is a database rule (a partial unique index). Several paths can notice
 * the same outage — the session leaving CONNECTED, a worker restart, the watchdog — and whichever
 * opens it first wins; the rest are no-ops.
 */

/** A just-closed gap still accepts its recovery result for this long — the sweep runs right after the connect. */
const RECOVERY_ATTACH_WINDOW_MS = 30 * 60_000;

const isUniqueViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

/** Opens a gap for the account (inside its project). False when one is already open. */
export async function openCollectionGap(accountId: string, cause: string, startedAt: Date): Promise<boolean> {
  try {
    await prisma.collectionGap.create({ data: { projectId: currentProjectId(), accountId, cause, startedAt } });
    return true;
  } catch (err) {
    if (!isUniqueViolation(err)) console.error(`[gaps] could not open a collection gap for account ${accountId}`, err);
    return false;
  }
}

/**
 * The same, for code running outside any project — boot reconciliation, which covers every project
 * this worker holds. The project is the account's own.
 */
export async function openCollectionGapForAccount(account: { id: string; projectId: string }, cause: string, startedAt: Date): Promise<boolean> {
  try {
    await platformPrisma.collectionGap.create({ data: { projectId: account.projectId, accountId: account.id, cause, startedAt } });
    return true;
  } catch (err) {
    if (!isUniqueViolation(err)) console.error(`[gaps] could not open a collection gap for account ${account.id}`, err);
    return false;
  }
}

/** Closes the account's open gap, if any. Never before it began. */
export async function closeCollectionGap(accountId: string, endedAt: Date): Promise<boolean> {
  try {
    const open = await prisma.collectionGap.findFirst({ where: { accountId, endedAt: null }, select: { id: true, startedAt: true } });
    if (!open) return false;
    await prisma.collectionGap.update({
      where: { id: open.id },
      data: { endedAt: endedAt < open.startedAt ? open.startedAt : endedAt },
    });
    return true;
  } catch (err) {
    console.error(`[gaps] could not close the collection gap for account ${accountId}`, err);
    return false;
  }
}

export interface GapRecovery {
  /** What the sweep could do. */
  status: CollectionGapRecovery;
  /** Start of the window the sweep read; null when no sweep ran. */
  from: Date | null;
  count: number;
  note: string | null;
}

/**
 * Attaches a sweep's result to the gap it was recovering: the account's newest gap still waiting for
 * one, open or closed within the last half hour. A sweep with no such gap (an ordinary reconnect
 * before this table existed, a first link) records nothing.
 */
export async function recordGapRecovery(accountId: string, recovery: GapRecovery, now = new Date()): Promise<boolean> {
  try {
    const gap = await prisma.collectionGap.findFirst({
      where: {
        accountId,
        recoveryStatus: null,
        OR: [{ endedAt: null }, { endedAt: { gte: new Date(now.getTime() - RECOVERY_ATTACH_WINDOW_MS) } }],
      },
      orderBy: { startedAt: "desc" },
      select: { id: true },
    });
    if (!gap) return false;
    await prisma.collectionGap.update({
      where: { id: gap.id },
      data: {
        recoveryStatus: recovery.status,
        recoveryAttemptedAt: now,
        recoveredFrom: recovery.from,
        recoveredCount: recovery.count,
        recoveryNote: recovery.note,
      },
    });
    return true;
  } catch (err) {
    console.error(`[gaps] could not record recovery for account ${accountId}`, err);
    return false;
  }
}
