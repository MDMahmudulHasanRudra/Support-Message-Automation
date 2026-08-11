"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";

export async function toggleGroupMonitoring(id: string): Promise<void> {
  await requireSession();
  const group = await prisma.whatsAppGroup.findUniqueOrThrow({ where: { id } });
  await prisma.whatsAppGroup.update({ where: { id }, data: { isMonitored: !group.isMonitored } });
  revalidatePath("/groups");
}

export interface BulkMonitoringResult {
  requested: number;
  updated: number;
  alreadyInTargetState: number;
  notFound: number;
  error?: string;
}

/**
 * Single atomic updateMany — Postgres already guarantees this is all-or-nothing, so there's no
 * separate transaction to wrap it in. Idempotent by construction: setting isMonitored to a value
 * rows already have is a no-op write, and re-running with the same ids/enabled always converges
 * to the same end state. Never trusts the client's selection as-is beyond deduping/filtering it.
 *
 * ENGINEERING_STANDARDS.md §2: a bulk action must report a meaningful breakdown ("8 updated, 1
 * already monitored, 1 not found"), never just "Done" — so this reads current state first to
 * distinguish "genuinely changed" from "already correct" before writing.
 */
export async function bulkSetMonitoring(groupIds: string[], enabled: boolean): Promise<BulkMonitoringResult> {
  await requireSession();

  const dedupedIds = [...new Set(groupIds.filter((id) => typeof id === "string" && id.length > 0))];
  if (dedupedIds.length === 0) {
    return { requested: 0, updated: 0, alreadyInTargetState: 0, notFound: 0, error: "No groups selected." };
  }

  const existing = await prisma.whatsAppGroup.findMany({
    where: { id: { in: dedupedIds } },
    select: { id: true, isMonitored: true },
  });
  const existingIds = new Set(existing.map((g) => g.id));
  const notFound = dedupedIds.filter((id) => !existingIds.has(id)).length;
  const alreadyInTargetState = existing.filter((g) => g.isMonitored === enabled).length;
  const idsToChange = existing.filter((g) => g.isMonitored !== enabled).map((g) => g.id);

  let updated = 0;
  if (idsToChange.length > 0) {
    const result = await prisma.whatsAppGroup.updateMany({
      where: { id: { in: idsToChange } },
      data: { isMonitored: enabled },
    });
    updated = result.count;
  }

  revalidatePath("/groups");
  return { requested: dedupedIds.length, updated, alreadyInTargetState, notFound };
}

/**
 * Queues an on-demand participant-count lookup for one group — never part of the bulk resync
 * path. ENGINEERING_STANDARDS.md §9: skip creating a duplicate if one is already in flight for
 * this exact group (clicking "Fetch" twice quickly shouldn't queue two lookups).
 */
export async function requestGroupParticipantCount(groupId: string): Promise<void> {
  await requireSession();
  const existing = await prisma.workerCommand.findFirst({
    where: {
      type: "GET_GROUP_PARTICIPANT_COUNT",
      status: { in: ["PENDING", "PROCESSING"] },
      payload: { path: ["groupId"], equals: groupId },
    },
  });
  if (existing) return;

  await prisma.workerCommand.create({
    data: { type: "GET_GROUP_PARTICIPANT_COUNT", payload: { groupId } },
  });
  revalidatePath("/groups");
}
