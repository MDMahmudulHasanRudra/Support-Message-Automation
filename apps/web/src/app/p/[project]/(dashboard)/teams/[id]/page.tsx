import { prisma } from "@/server/db";
import Link from "@/components/ProjectLink";
import { notFound } from "next/navigation";
import { ArrowLeft, BarChart3 } from "lucide-react";

import { pageAccess } from "@/server/authorize";
import { Badge, ButtonLink, Card, EmptyState, PageHeader, SectionHeader, Table, Td, Th } from "@/components/ui";

export const metadata = { title: "Team" };

const day = (date: Date | null) =>
  date
    ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short", year: "numeric" }).format(date)
    : "the start";

/** One Team: who is in it now, who was in it before, and a way into its Team Report. */
export default async function TeamPage({ params }: { params: Promise<{ id: string }> }) {
  const { canManage } = await pageAccess("whatsapp.view", "whatsapp.manage");
  const { id } = await params;
  const team = await prisma.team.findUnique({
    where: { id },
    include: {
      members: { orderBy: { name: "asc" }, select: { id: true, name: true, phoneNumber: true, role: true, department: true, status: true } },
      memberships: {
        where: { endedAt: { not: null } },
        orderBy: { endedAt: "desc" },
        include: { teamMember: { select: { id: true, name: true } } },
      },
    },
  });
  if (!team) notFound();

  return (
    <div>
      <Link href="/teams" className="mb-3 inline-flex items-center gap-1.5 text-[13px] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]">
        <ArrowLeft className="size-3.5" aria-hidden />
        All teams
      </Link>
      <PageHeader
        title={team.name}
        description={[team.code, team.description].filter(Boolean).join(" · ") || "No description."}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge color={team.status === "ACTIVE" ? "green" : "gray"} dot>
              {team.status}
            </Badge>
            <ButtonLink href={`/team-report?team=${team.id}`}>
              <BarChart3 className="size-3.5" aria-hidden />
              Team Report
            </ButtonLink>
            {canManage ? <ButtonLink href={`/teams/${team.id}/edit`}>Edit</ButtonLink> : null}
          </div>
        }
      />

      <Card className="mb-5">
        <SectionHeader
          title={`Members (${team.members.length})`}
          description="Assign or move people on Internal Team Members, from each person's Edit page."
        />
        {team.members.length === 0 ? (
          <EmptyState>Nobody is in this team yet. Pick it as the Team when adding or editing a member.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Phone</Th>
                <Th>Designation</Th>
                <Th>Department</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {team.members.map((member) => (
                <tr key={member.id}>
                  <Td>
                    {canManage ? (
                      <Link className="link" href={`/team-members/${member.id}/edit`}>
                        {member.name}
                      </Link>
                    ) : (
                      member.name
                    )}
                  </Td>
                  <Td className="font-[family-name:var(--font-mono)] text-xs">{member.phoneNumber}</Td>
                  <Td>{member.role}</Td>
                  <Td>{member.department ?? "—"}</Td>
                  <Td>
                    <Badge color={member.status === "ACTIVE" ? "green" : "gray"} dot>
                      {member.status}
                    </Badge>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {team.memberships.length > 0 ? (
        <Card>
          <SectionHeader
            title="Previously in this team"
            description="Their work up to the day they moved still counts for this team in the Team Report."
          />
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>In this team</Th>
              </tr>
            </thead>
            <tbody>
              {team.memberships.map((membership) => (
                <tr key={membership.id}>
                  <Td>{membership.teamMember.name}</Td>
                  <Td className="tabular text-[color:var(--color-muted-foreground)]">
                    From {day(membership.startedAt)} until {day(membership.endedAt)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      ) : null}
    </div>
  );
}
