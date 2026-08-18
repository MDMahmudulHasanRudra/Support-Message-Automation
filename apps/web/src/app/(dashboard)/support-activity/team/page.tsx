import Link from "next/link";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { getSupportActivityPeriodRange } from "@/lib/supportActivityPeriod";
import { getPerTeamMemberBreakdown } from "@/server/supportActivityReports";
import { Card, EmptyState, HelpButton, HelpSection, PageHeader, SectionHeader, Table, Td, Th } from "@/components/ui";

const PERIOD_LABEL: Record<string, string> = {
  DAILY: "Today",
  WEEKLY: "This Week",
  MONTHLY: "This Month",
};

export default async function SupportActivityTeamPage() {
  await requireSession();

  const settings = await prisma.supportActivitySettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" },
  });
  const period = getSupportActivityPeriodRange(settings.countingPeriod, new Date());
  const periodLabel = PERIOD_LABEL[settings.countingPeriod] ?? "Today";
  const breakdown = await getPerTeamMemberBreakdown(period);
  const exportParams = `from=${period.start.toISOString()}&to=${period.end.toISOString()}`;

  return (
    <div>
      <PageHeader
        title="Team Performance"
        description="Support activity for the current counting period, broken down per team member."
        actions={
          <HelpButton moduleTitle="Team Performance">
            <HelpSection title="What this shows">
              <p>
                One row per support team member with any detected activity in the current counting
                period (set on the Settings page) — the total number of activities they were
                credited with. To add or edit the roster of support team members themselves, use
                the{" "}
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
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SectionHeader title={periodLabel} />
          <div className="flex gap-3 pb-4 text-xs">
            <a
              className="text-[color:var(--color-primary)] underline"
              href={`/api/support-activity/export?type=team&format=csv&${exportParams}`}
            >
              Export CSV
            </a>
            <a
              className="text-[color:var(--color-primary)] underline"
              href={`/api/support-activity/export?type=team&format=xlsx&${exportParams}`}
            >
              Export Excel
            </a>
          </div>
        </div>
        {breakdown.length === 0 ? (
          <EmptyState>No support activity recorded in this period yet.</EmptyState>
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
