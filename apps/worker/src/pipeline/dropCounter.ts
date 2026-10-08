import { withAccountProject } from "../project/context.js";
import { prisma } from "../db.js";
import type { MessageDropReason } from "@prisma/client";
import { toDhakaDateOnly } from "@support-automation/shared";

/**
 * Records that a message reached this worker and produced no row.
 *
 * This is the one thing the 18 Sep 2026 outage could not establish about itself. Messages stopped
 * appearing, and the first question — did they arrive and get discarded, or never arrive at all? —
 * had no answer anywhere: a dropped message leaves no trace by definition, and `metrics.received`
 * lives in memory, so the restart that is always the first thing tried erases it.
 *
 * Every other number in this product is derived from rows that exist, which is right, and is
 * exactly why this one has to be written down: it is the only quantity that cannot be. With it,
 * "received" finally becomes derivable too — stored plus dropped.
 *
 * **Never awaited by the caller, and it can never throw.** This runs on the message path. A
 * counter failing to increment is a missing statistic; a counter taking down message processing
 * would be the failure it exists to detect, caused by the thing detecting it.
 */
export function countDroppedMessage(accountId: string, reason: MessageDropReason): void {
  void recordDrop(accountId, reason).catch((err) => {
    console.warn("[pipeline] could not record a dropped message", err);
  });
}

async function recordDrop(accountId: string, reason: MessageDropReason): Promise<void> {
  return withAccountProject(accountId, () => recordDropInProject(accountId, reason));
}

async function recordDropInProject(accountId: string, reason: MessageDropReason): Promise<void> {
  // Dhaka day, matching every other daily figure in this product — a UTC midnight falls at 06:00
  // local and would split a morning's drops across two days.
  const day = toDhakaDateOnly(new Date());
  await prisma.messageDropCounter.upsert({
    where: { accountId_day_reason: { accountId, day, reason } },
    // `increment` rather than read-then-write: the pipeline is concurrent, and two drops arriving
    // together must not lose one. Postgres settles it inside the single UPDATE.
    update: { count: { increment: 1 } },
    create: { accountId, day, reason, count: 1 },
  });
}
