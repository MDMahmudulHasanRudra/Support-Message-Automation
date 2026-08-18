import Link from "next/link";
import { requireSession } from "@/server/auth";
import { getDhakaDayRange } from "@/lib/supportActivityPeriod";
import { getPerTeamMemberBreakdown } from "@/server/supportActivityReports";
import { Card, EmptyState, HelpButton, HelpSection, PageHeader, SectionHeader, Table, Td, Th } from "@/components/ui";

export default async function SupportActivityTeamPage() {
  await requireSession();

  const today = getDhakaDayRange(new Date());
  const breakdown = await getPerTeamMemberBreakdown(today);

  return (
    <div>
      <PageHeader
        title="Team Performance"
        description="Today's support activity, broken down per team member."
        actions={
          <HelpButton moduleTitle="Team Performance">
            <HelpSection title="What this shows">
              <p>
                One row per support team member with any detected activity today — the total
                number of activities they were credited with. To add or edit the roster of support
                team members themselves, use the{" "}
                <Link href="/team-members" className="underline">
                  Internal Team Members
                </Link>{" "}
                page — this is a read-only report, not a duplicate of that CRUD.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />

      <Card>
        <SectionHeader title="Today" />
        {breakdown.length === 0 ? (
          <EmptyState>No support activity recorded today yet.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Member</Th>
                <Th>Activities</Th>
              </tr>
            </thead>
            <tbody>
              {breakdown.map((row) => (
                <tr key={row.teamMemberId}>
                  <Td>{row.name}</Td>
                  <Td className="tabular-nums">{row.activityCount}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
