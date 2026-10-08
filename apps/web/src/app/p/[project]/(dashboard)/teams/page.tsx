
import { prisma } from "@/server/db";
import { pageAccess } from "@/server/authorize";
import { Card, HelpButton, HelpSection, PageHeader, SectionHeader, ViewOnlyNotice } from "@/components/ui";
import { TeamForm } from "./TeamForm";
import { TeamsTable } from "./TeamsTable";

export const metadata = { title: "Teams" };

export default async function TeamsPage() {
  const { canManage } = await pageAccess("whatsapp.view", "whatsapp.manage");
  const teams = await prisma.team.findMany({
    orderBy: [{ status: "asc" }, { name: "asc" }],
    include: { _count: { select: { members: true } } },
  });

  return (
    <div>
      <PageHeader
        title="Teams"
        description="Manage organizational teams and assign internal members to each team."
        actions={
          <HelpButton moduleTitle="Teams">
            <HelpSection title="What a team is for">
              <p>
                A team groups the people on Internal Team Members — Support Team, Billing Team, Commercial
                Team. Each member belongs to one team, chosen on their own row there, and Reports → Team
                Report can then show one team&apos;s work on its own.
              </p>
            </HelpSection>
            <HelpSection title="Team, Department and Designation are different">
              <p>
                Team is the group someone works in; Department is the part of the company they sit in;
                Designation is their job title. All three are kept on the member.
              </p>
            </HelpSection>
            <HelpSection title="Moving someone to another team">
              <p>
                Their past work stays with the team they were in at the time. A report for last month still
                counts them where they were last month; from the day of the move they count for the new team.
                A member&apos;s first team counts back over everything before it, so reports can be filtered
                by team as soon as teams are set up.
              </p>
            </HelpSection>
            <HelpSection title="Disable vs. Delete">
              <p>
                <strong>Disable</strong> stops a team being offered when adding or editing members. Its members
                keep it and reports can still show it. <strong>Delete</strong> is only possible for a team that
                has never had members — once people have been in it, its history is what earlier reports read.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />

      {canManage ? null : <ViewOnlyNotice />}

      {canManage ? (
        <Card className="mb-6">
          <SectionHeader title="Add Team" />
          <TeamForm />
        </Card>
      ) : null}

      <TeamsTable
        canManage={canManage}
        teams={teams.map((team) => ({
          id: team.id,
          name: team.name,
          code: team.code,
          description: team.description,
          status: team.status,
          memberCount: team._count.members,
        }))}
      />
    </div>
  );
}
