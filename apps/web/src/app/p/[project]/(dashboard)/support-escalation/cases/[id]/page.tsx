import { prisma } from "@/server/db";
import { notFound } from "next/navigation";
import Link from "@/components/ProjectLink";
import { ArrowLeft } from "lucide-react";

import { pageAccess } from "@/server/authorize";
import { Badge, type BadgeColor, Card, PageHeader, SectionHeader, Table, Td, Th, ViewOnlyNotice } from "@/components/ui";
import { AutoRefresh } from "@/components/AutoRefresh";
import { formatDateTime } from "@/lib/date";
import { CaseActions } from "./CaseActions";

const ACTIVE_STATUSES = new Set([
  "NEW",
  "MONITORING",
  "WAITING_FOR_HUMAN",
  "SECOND_ALERT",
  "MEMBER_ESCALATED",
  "ADMIN_ESCALATED",
  "FOLLOW_UP",
]);

export default async function SupportEscalationCasePage({ params }: { params: Promise<{ id: string }> }) {
  const { canManage } = await pageAccess("escalations.view", "escalations.manage");
  const { id } = await params;

  const [caseRow, teamMembers] = await Promise.all([
    prisma.supportEscalationCase.findUnique({
      where: { id },
      include: {
        group: { select: { name: true } },
        assignedTeamMember: { select: { name: true } },
        resolvedBy: { select: { name: true, email: true } },
        triggerMessage: { select: { body: true, senderName: true, senderPhone: true } },
        events: { orderBy: { createdAt: "asc" }, include: { notification: { select: { status: true } } } },
      },
    }),
    prisma.internalTeamMember.findMany({ where: { status: "ACTIVE" }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  if (!caseRow) notFound();

  const isActive = ACTIVE_STATUSES.has(caseRow.status);

  return (
    <div>
      <PageHeader title={`Priority Case: ${caseRow.group.name}`} description={`Case ${caseRow.id}`} />

      {canManage ? null : <ViewOnlyNotice />}

      <p className="mb-4">
        <Link
          href="/support-escalation"
          className="inline-flex items-center gap-1 text-sm text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          Back to Active Cases
        </Link>
      </p>

      <div className="space-y-4">
        <Card>
          <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <Field label="Priority" value={<Badge color={caseRow.priority === "P1" ? "red" : caseRow.priority === "P2" ? "yellow" : "blue"} dot>{caseRow.priority}</Badge>} />
            <Field label="Status" value={<Badge color={statusColor(caseRow.status)} dot>{caseRow.status}</Badge>} />
            <Field label="Client" value={caseRow.triggerMessage.senderName ?? caseRow.clientPhone} />
            <Field label="Assigned" value={caseRow.assignedTeamMember?.name ?? "—"} />
            <Field label="Escalation Level" value={`${caseRow.escalationLevel} / ${caseRow.maxEscalations}`} />
            <Field label="Waiting Since" value={formatDateTime(caseRow.lastCustomerMessageAt)} />
            <Field label="Human Replied At" value={caseRow.humanRepliedAt ? formatDateTime(caseRow.humanRepliedAt) : "—"} />
            <Field label="Resolved" value={caseRow.resolvedAt ? `${formatDateTime(caseRow.resolvedAt)} by ${caseRow.resolvedBy?.name ?? "—"}` : "—"} />
          </dl>
          <div className="mt-4">
            <p className="mb-1 text-xs font-medium text-[color:var(--color-muted-foreground)]">Original Message</p>
            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-neutral-bg)] p-3 text-sm text-[color:var(--color-foreground)]">
              {caseRow.triggerMessage.body}
            </div>
          </div>
        </Card>

        {/* Not rendered for a view-only role: every button here would be refused, and a refusal from
            these is a redirect to the Overview — a worse experience than simply not offering them. */}
        {canManage ? (
          <Card>
            <SectionHeader title="Actions" />
            <CaseActions
              caseId={caseRow.id}
              status={caseRow.status}
              assignedTeamMemberId={caseRow.assignedTeamMemberId}
              teamMembers={teamMembers}
            />
          </Card>
        ) : null}

        <Card>
          <SectionHeader title={`Timeline (${caseRow.events.length} event(s))`} />
          <Table>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Event</Th>
                <Th>Recipient</Th>
                <Th>Delivery</Th>
              </tr>
            </thead>
            <tbody>
              {caseRow.events.map((e) => (
                <tr key={e.id}>
                  <Td>{formatDateTime(e.createdAt)}</Td>
                  <Td>{e.eventType.replace(/_/g, " ")}</Td>
                  <Td>{e.recipientLabel}</Td>
                  <Td>
                    {e.notification ? (
                      <Badge color={e.notification.status === "SENT" ? "green" : e.notification.status === "FAILED" ? "red" : "yellow"} dot>
                        {e.notification.status}
                      </Badge>
                    ) : (
                      "—"
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>

      {isActive ? <AutoRefresh intervalMs={5000} /> : null}
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-[color:var(--color-muted-foreground)]">{label}</dt>
      <dd className="mt-0.5 text-[color:var(--color-foreground)]">{value}</dd>
    </div>
  );
}

function statusColor(status: string): BadgeColor {
  if (status === "NEW" || status === "MONITORING") return "gray";
  if (status === "WAITING_FOR_HUMAN") return "yellow";
  if (status === "HUMAN_REPLIED" || status === "RESOLVED") return "green";
  if (status === "CANCELLED" || status === "PAUSED") return "gray";
  return "red";
}
