/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { formatDateTime } from "@/lib/date";
import { getDhakaDayRange } from "@/lib/supportActivityPeriod";
import { getEveryActivityCount, getRecentActivities, getUniqueGroupCount } from "@/server/supportActivityReports";
import { Badge, Card, EmptyState, HelpButton, HelpSection, PageHeader, SectionHeader, StatTile, Table, Td, Th } from "@/components/ui";

export default async function SupportActivityPage() {
  await requireSession();

  const settings = await prisma.supportActivitySettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" },
  });

  const today = getDhakaDayRange(new Date());

  const [todaySupportedGroups, todayActivities, activeSupportMembers, totalSupportedGroupsEver, recentActivities] =
    await Promise.all([
      getUniqueGroupCount(today),
      getEveryActivityCount(today),
      prisma.internalTeamMember.count({ where: { status: "ACTIVE" } }),
      prisma.supportActivity.groupBy({ by: ["groupId"] }).then((rows) => rows.length),
      getRecentActivities(10),
    ]);

  const repeatedToday = Math.max(0, todayActivities - todaySupportedGroups);

  return (
    <div>
      <PageHeader
        title="Support Activity"
        description="Automatically detected support keyword activity from configured support team members inside WhatsApp groups."
        actions={
          <HelpButton moduleTitle="Support Activity">
            <HelpSection title="What this page is for">
              <p>
                A summary of support activity detected automatically from real conversations — a
                support team member's message matching a configured keyword/rule inside a WhatsApp
                group. Nothing here sends or changes a customer message; this is read-only tracking.
              </p>
            </HelpSection>
            <HelpSection title="Repeated Support Activities">
              <p>
                The difference between total activities and unique supported groups today — a
                positive number means at least one group received more than one support action
                today. This distinction matters because the "Counted Support" total on the Reports
                page depends on which Counting Mode is configured in Settings.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />

      {!settings.enabled ? (
        <div className="mb-6">
          <EmptyState>
            Support Activity Tracking is currently disabled — enable it on the Settings page to
            start detecting activity.
          </EmptyState>
        </div>
      ) : null}

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-5">
        <StatTile label="Today's Support Groups" value={todaySupportedGroups} />
        <StatTile label="Today's Support Activities" value={todayActivities} />
        <StatTile label="Active Support Members" value={activeSupportMembers} />
        <StatTile label="Total Supported Groups" value={totalSupportedGroupsEver} />
        <StatTile label="Repeated Support Activities" value={repeatedToday} tone={repeatedToday > 0 ? "warning" : "neutral"} />
      </div>

      <Card>
        <SectionHeader title="Recent Activity" description="Last 10 detected support activities across every group." />
        {recentActivities.length === 0 ? (
          <EmptyState>No support activity detected yet.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Time</Th>
                <Th>Group</Th>
                <Th>Team Member</Th>
                <Th>Keyword</Th>
                <Th>Message</Th>
              </tr>
            </thead>
            <tbody>
              {recentActivities.map((a) => (
                <tr key={a.id}>
                  <Td className="font-[family-name:var(--font-mono)] text-xs whitespace-nowrap">{formatDateTime(a.occurredAt)}</Td>
                  <Td>{a.groupName}</Td>
                  <Td>{a.teamMemberName ?? "—"}</Td>
                  <Td>{a.keywordValue ? <Badge color="blue">{a.keywordValue}</Badge> : "—"}</Td>
                  <Td className="max-w-md truncate">{a.messageBody}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
