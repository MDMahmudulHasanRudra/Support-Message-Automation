/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */
import Link from "next/link";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import type { EscalationStatus } from "@prisma/client";
import { Badge, type BadgeColor, Button, EmptyState, HelpButton, HelpSection, PageHeader, StatTile, Table, Td, Th } from "@/components/ui";
import { formatDateTime } from "@/lib/date";

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
        title="Active Cases"
        description="High-priority groups with unanswered customer messages, and where escalation currently stands. Configure per-group priority on the Groups page."
        actions={
          <HelpButton moduleTitle="Active Cases">
            <HelpSection title="What this page is for">
              <p>
                Lists every currently active case — a priority-tagged group with a customer message
                nobody's replied to yet — sorted so the longest-waiting case is always at the top.
                Resolved/cancelled/human-replied cases drop off this list automatically (they're still
                viewable via their own case page, just not listed here as active).
              </p>
            </HelpSection>
            <HelpSection title="How a case gets here">
              <p>
                Only groups tagged P1/P2/P3 on the Groups page are monitored at all — it's entirely
                opt-in. A case opens automatically the moment a non-team-member sends a message in a
                monitored group's chat with no case already open for it; a second message while one is
                open just extends the existing case rather than duplicating it.
              </p>
            </HelpSection>
            <HelpSection title="Status meanings">
              <p>
                NEW/MONITORING — just opened, nothing sent yet. WAITING_FOR_HUMAN — first group alert
                sent. SECOND_ALERT — a re-alert nudge sent. MEMBER_ESCALATED — assigned team member
                DM'd. ADMIN_ESCALATED — escalation admin DM'd. FOLLOW_UP — repeating follow-up DMs to
                the admin. Any real human reply in the chat immediately ends the chain — see the
                Policies page's help for exact timing.
              </p>
            </HelpSection>
            <HelpSection title="Manual controls (on the case detail page)">
              <p>
                <strong>Pause/Resume</strong> freezes/unfreezes the timers. <strong>Escalate
                Immediately</strong> forces the next tier to fire right now instead of waiting out its
                timer. <strong>Reassign</strong> changes who gets the member-tier DM, even mid-case.{" "}
                <strong>Reset</strong> puts a case back to the very start (keeping its history).{" "}
                <strong>Stop Escalation</strong> ends tracking without claiming a human replied.{" "}
                <strong>Mark Resolved</strong> closes it out for good, once the issue is actually
                handled.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
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
                <Td>{formatDateTime(c.lastCustomerMessageAt)}</Td>
                <Td className="tabular-nums">{c.escalationLevel}</Td>
                <Td>{c.assignedTeamMember?.name ?? "—"}</Td>
                <Td>
                  <Link href={`/support-escalation/cases/${c.id}`}>
                    <Button variant="secondary" size="sm">
                      View
                    </Button>
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
