import type { Prisma, SupportPriority } from "@prisma/client";
import { prisma } from "@/server/db";

/**
 * A WhatsApp group's assignee and priority AS THE TEAM REPORT READS THEM: one WhatsApp group is one
 * `WhatsAppGroup` row per account, and the report takes the Primary account's copy first, then any
 * copy somebody configured. `GroupResponsibilityChange` is recorded on this merged value — recording a
 * row's own before/after charged a wait to "Unassigned" when one copy was unassigned while another,
 * the one the report reads, was assigned throughout.
 */
export interface GroupResponsibility {
  assignedTeamMemberId: string | null;
  priority: SupportPriority | null;
}

type Client = Prisma.TransactionClient | typeof prisma;

export async function mergedGroupResponsibility(client: Client, whatsappGroupId: string): Promise<GroupResponsibility> {
  const rows = await client.whatsAppGroup.findMany({
    where: { whatsappGroupId },
    select: { assignedTeamMemberId: true, priority: true, account: { select: { isPrimary: true } } },
    orderBy: [{ account: { isPrimary: "desc" } }, { id: "asc" }],
  });
  return {
    assignedTeamMemberId: rows.find((r) => r.assignedTeamMemberId)?.assignedTeamMemberId ?? null,
    priority: rows.find((r) => r.priority)?.priority ?? null,
  };
}

/** Records a change of the merged value, when there is one. */
export async function recordResponsibilityChange(
  client: Client,
  whatsappGroupId: string,
  before: GroupResponsibility,
  after: GroupResponsibility,
  changedByUserId: string | null,
): Promise<void> {
  if (before.assignedTeamMemberId === after.assignedTeamMemberId && before.priority === after.priority) return;
  await client.groupResponsibilityChange.create({
    data: {
      whatsappGroupId,
      previousAssignedTeamMemberId: before.assignedTeamMemberId,
      previousPriority: before.priority,
      assignedTeamMemberId: after.assignedTeamMemberId,
      priority: after.priority,
      changedByUserId,
    },
  });
}
