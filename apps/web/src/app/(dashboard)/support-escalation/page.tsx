import Link from "next/link";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import type { EscalationStatus } from "@prisma/client";
import { Badge, type BadgeColor, EmptyState, PageHeader, StatTile, Table, Td, Th } from "@/components/ui";

const ACTIVE_STATUSES: EscalationStatus[] = [
  "NEW",
  "MONITORING",
  "WAITING_FOR_HUMAN",
  "SECOND_ALERT",
  "MEMBER_ESCALATED",
  "ADMIN_ESCALATED",
  "FOLLOW_UP",
];

export default async function SupportEscalationDashboardPage() {
  await requireSession();

  const [activeCases, waitingCount, escalatedCount, pausedCount, resolvedTodayCount] = await Promise.all([
    prisma.supportEscalationCase.findMany({
      where: { status: { in: ACTIVE_STATUSES } },
      include: { group: { select: { name: true } }, assignedTeamMember: { select: { name: true } } },
      orderBy: { lastCustomerMessageAt: "asc" },
    }),
    prisma.supportEscalationCase.count({ where: { status: { in: ["NEW", "MONITORING", "WAITING_FOR_HUMAN"] } } }),
    prisma.supportEscalationCase.count({ where: { status: { in: ["SECOND_ALERT", "MEMBER_ESCALATED", "ADMIN_ESCALATED", "FOLLOW_UP"] } } }),
    prisma.supportEscalationCase.count({ where: { status: "PAUSED" } }),
    prisma.supportEscalationCase.count({ where: { resolvedAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } } }),
  ]);

  return (
    <div>
      <PageHeader
        title="Priority Support Monitoring"
        description="High-priority groups with unanswered customer messages, and where escalation currently stands. Configure per-group priority on the Groups page."
      />

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Waiting for first response" value={waitingCount} tone={waitingCount > 0 ? "warning" : "neutral"} />
        <StatTile label="Escalated" value={escalatedCount} tone={escalatedCount > 0 ? "danger" : "neutral"} />
        <StatTile label="Paused" value={pausedCount} />
        <StatTile label="Resolved today" value={resolvedTodayCount} tone="success" />
      </div>

      {activeCases.length === 0 ? (
        <EmptyState>No active priority support cases right now.</EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Group</Th>
              <Th>Priority</Th>
              <Th>Status</Th>
              <Th>Waiting Since</Th>
              <Th>Escalation Level</Th>
              <Th>Assigned</Th>
              <Th>{null}</Th>
            </tr>
          </thead>
          <tbody>
            {activeCases.map((c) => (
              <tr key={c.id}>
                <Td>{c.group.name}</Td>
                <Td>
                  <Badge color={c.priority === "P1" ? "red" : c.priority === "P2" ? "yellow" : "blue"} dot>
                    {c.priority}
                  </Badge>
                </Td>
                <Td>
                  <Badge color={statusColor(c.status)} dot>
                    {c.status}
                  </Badge>
                </Td>
                <Td>{c.lastCustomerMessageAt.toLocaleString()}</Td>
                <Td className="tabular-nums">{c.escalationLevel}</Td>
                <Td>{c.assignedTeamMember?.name ?? "—"}</Td>
                <Td>
                  <Link
                    href={`/support-escalation/cases/${c.id}`}
                    className="text-sm text-[color:var(--color-primary)] underline"
                  >
                    View
                  </Link>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}

function statusColor(status: string): BadgeColor {
  if (status === "NEW" || status === "MONITORING") return "gray";
  if (status === "WAITING_FOR_HUMAN") return "yellow";
  return "red";
}
