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
  updated: number;
  error?: string;
}

/**
 * Single atomic updateMany — Postgres already guarantees this is all-or-nothing, so there's no
 * separate transaction to wrap it in. Idempotent by construction: setting isMonitored to a value
 * rows already have is a no-op write, and re-running with the same ids/enabled always converges
 * to the same end state. Never trusts the client's selection as-is beyond deduping/filtering it.
 */
export async function bulkSetMonitoring(groupIds: string[], enabled: boolean): Promise<BulkMonitoringResult> {
  await requireSession();

  const dedupedIds = [...new Set(groupIds.filter((id) => typeof id === "string" && id.length > 0))];
  if (dedupedIds.length === 0) {
    return { updated: 0, error: "No groups selected." };
  }

  const result = await prisma.whatsAppGroup.updateMany({
    where: { id: { in: dedupedIds } },
    data: { isMonitored: enabled },
  });

  revalidatePath("/groups");
  return { updated: result.count };
}

/** Queues an on-demand participant-count lookup for one group — never part of the bulk resync path. */
export async function requestGroupParticipantCount(groupId: string): Promise<void> {
  await requireSession();
  await prisma.workerCommand.create({
    data: { type: "GET_GROUP_PARTICIPANT_COUNT", payload: { groupId } },
  });
  revalidatePath("/groups");
}
