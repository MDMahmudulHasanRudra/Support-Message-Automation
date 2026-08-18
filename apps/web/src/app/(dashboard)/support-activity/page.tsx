/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { formatDateTime } from "@/lib/date";
import { getSupportActivityPeriodRange } from "@/lib/supportActivityPeriod";
import { getActivityTrend, getEveryActivityCount, getRecentActivities, getUniqueGroupCount } from "@/server/supportActivityReports";
import {
  Badge,
  Card,
  EmptyState,
  HelpButton,
  HelpSection,
  PageHeader,
  SectionHeader,
  Sparkline,
  StatTile,
  Table,
  Td,
  Th,
} from "@/components/ui";

const PERIOD_LABEL: Record<string, string> = {
  DAILY: "Today's",
  WEEKLY: "This Week's",
  MONTHLY: "This Month's",
};

export default async function SupportActivityPage() {
  await requireSession();

  const settings = await prisma.supportActivitySettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" },
  });

  const period = getSupportActivityPeriodRange(settings.countingPeriod, new Date());
  const periodLabel = PERIOD_LABEL[settings.countingPeriod] ?? "Today's";

  const [periodSupportedGroups, periodActivities, activeSupportMembers, totalSupportedGroupsEver, recentActivities, trend] =
    await Promise.all([
      getUniqueGroupCount(period),
      getEveryActivityCount(period),
      prisma.internalTeamMember.count({ where: { status: "ACTIVE" } }),
      prisma.supportActivity.groupBy({ by: ["groupId"] }).then((rows) => rows.length),
      getRecentActivities(10),
      getActivityTrend(30),
    ]);

  const repeatedThisPeriod = Math.max(0, periodActivities - periodSupportedGroups);
  const exportParams = `from=${period.start.toISOString()}&to=${period.end.toISOString()}`;

  return (
    <div>
      <PageHeader
        title="Support Activity"
        description="Automatically detected support keyword/reply/mention activity from configured support team members inside WhatsApp groups."
        actions={
          <HelpButton moduleTitle="Support Activity">
            <HelpSection title="What this page is for">
              <p>
                A summary of support activity detected automatically from real conversations — a
                support team member's message matching a configured rule (keyword, reply to a
                customer, or mention) inside a WhatsApp group. Nothing here sends or changes a
                customer message; this is read-only tracking.
              </p>
            </HelpSection>
            <HelpSection title="Repeated Support Activities">
              <p>
                The difference between total activities and unique supported groups in the current
                period — a positive number means at least one group received more than one support
                action. This distinction matters because the "Counted Support" total depends on
                which Counting Mode is configured in Settings.
              </p>
            </HelpSection>
            <HelpSection title="Period">
              <p>
                The stat tiles below follow the Counting Period configured in Settings (Daily,
                Weekly, or Monthly) — change it there if you want a different window.
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
        <StatTile label={`${periodLabel} Support Groups`} value={periodSupportedGroups} />
        <StatTile label={`${periodLabel} Support Activities`} value={periodActivities} />
        <StatTile label="Active Support Members" value={activeSupportMembers} />
        <StatTile label="Total Supported Groups" value={totalSupportedGroupsEver} />
        <StatTile
          label="Repeated Support Activities"
          value={repeatedThisPeriod}
          tone={repeatedThisPeriod > 0 ? "warning" : "neutral"}
        />
      </div>

      <Card className="mb-6">
        <div className="flex items-center justify-between gap-4">
          <SectionHeader title="30-Day Trend" description="Daily support activity count." />
          <div className="w-40 shrink-0">
            <Sparkline data={trend} ariaLabel="Support activity, last 30 days" />
          </div>
        </div>
      </Card>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SectionHeader title="Recent Activity" description="Last 10 detected support activities across every group." />
          <div className="flex gap-3 pb-4 text-xs">
            <a
              className="text-[color:var(--color-primary)] underline"
              href={`/api/support-activity/export?type=activities&format=csv&${exportParams}`}
            >
              Export CSV
            </a>
            <a
              className="text-[color:var(--color-primary)] underline"
              href={`/api/support-activity/export?type=activities&format=xlsx&${exportParams}`}
            >
              Export Excel
            </a>
          </div>
        </div>
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
