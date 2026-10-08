import type { SupportAssignmentStatus } from "@prisma/client";
import { SUPPORT_ASSIGNMENT_STATUS_LABELS } from "@support-automation/shared";
import { Badge, type BadgeColor } from "@/components/ui";

/**
 * One colour per state, chosen for what the reader must do: red needs action now (overdue), amber
 * is waiting for somebody to pick it up, blue is in hand, green is done. "Answered by someone else"
 * is cyan rather than green — the customer was answered, but not by the person asked.
 */
const COLORS: Record<SupportAssignmentStatus, BadgeColor> = {
  OVERDUE: "red",
  UNASSIGNED: "yellow",
  ASSIGNED: "blue",
  COMPLETED: "green",
  ANSWERED_BY_OTHER: "cyan",
  CANCELLED: "gray",
  IGNORED: "gray",
};

export function AssignmentBadge({ status }: { status: SupportAssignmentStatus }) {
  return (
    <Badge color={COLORS[status]} dot={status === "OVERDUE" || status === "UNASSIGNED"}>
      {SUPPORT_ASSIGNMENT_STATUS_LABELS[status]}
    </Badge>
  );
}
