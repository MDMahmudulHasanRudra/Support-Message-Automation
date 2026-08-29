/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import Link from "next/link";
import { Download } from "lucide-react";
import { formatDateTime } from "@/lib/date";
import { formatDurationShort } from "@/lib/duration";
import { SetupBanner } from "./SetupBanner";
import { getSupportActivityPeriodRange } from "@/lib/supportActivityPeriod";
import {
  getActivityTrend,
  getActorBreakdown,
  getAverageResolutionTime,
  getEveryActivityCount,
  getRecentActivities,
  getStaleSessionCount,
  getUniqueGroupCount,
} from "@/server/supportActivityReports";
import {
  Alert,
  Badge,
  ButtonLink,
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

  const [
    periodSupportedGroups,
    periodActivities,
    activeSupportMembers,
    totalSupportedGroupsEver,
    recentActivities,
    trend,
    avgResolutionSeconds,
    staleSessionCount,
    actorBreakdown,
    activeRuleCount,
  ] = await Promise.all([
    getUniqueGroupCount(period),
    getEveryActivityCount(period),
    prisma.internalTeamMember.count({ where: { status: "ACTIVE" } }),
    prisma.supportActivity.groupBy({ by: ["groupId"] }).then((rows) => rows.length),
    getRecentActivities(10),
    getActivityTrend(30),
    getAverageResolutionTime(period),
    getStaleSessionCount(),
    getActorBreakdown(period),
    prisma.supportRule.count({ where: { isActive: true } }),
  ]);

  const repeatedThisPeriod = Math.max(0, periodActivities - periodSupportedGroups);
  const exportParams = `from=${period.start.toISOString()}&to=${period.end.toISOString()}`;

  return (
    <div>
      <PageHeader
        title="Support Activity"
        description="Monitor support activity, resolution performance, and team availability."
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

      <SetupBanner
        trackingEnabled={settings.enabled}
        activeRuleCount={activeRuleCount}
        activeMemberCount={activeSupportMembers}
      />

      {!settings.enabled ? (
        <div className="mb-6">
          <EmptyState>
            Support Activity Tracking is currently disabled — enable it on the Settings page to
            start detecting activity.
          </EmptyState>
        </div>
      ) : null}

      {staleSessionCount > 0 ? (
        <div className="mb-6">
          <Alert
            tone="warning"
            title={`${staleSessionCount} support session${staleSessionCount === 1 ? "" : "s"} need${staleSessionCount === 1 ? "s" : ""} attention`}
          >
            These sessions have been open for more than 4 hours. Review them from{" "}
            <Link href="/support-activity/reports" className="underline">
              Support Activity → Reports
            </Link>
            .
          </Alert>
        </div>
      ) : null}

      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label={`${periodLabel} Support Groups`} value={periodSupportedGroups} />
        <StatTile label={`${periodLabel} Support Activities`} value={periodActivities} />
        <StatTile label="Active Support Members" value={activeSupportMembers} />
        <StatTile
          label={`${periodLabel} AI-Handled`}
          value={actorBreakdown.aiCount}
          hint={
            actorBreakdown.aiOnlyGroups > 0
              ? `${actorBreakdown.aiOnlyGroups} group(s) had no human involvement`
              : "Counted separately from team totals"
          }
          tone={actorBreakdown.aiCount > 0 ? "success" : "neutral"}
        />
        <StatTile label="Total Supported Groups" value={totalSupportedGroupsEver} />
        <StatTile
          label="Repeated Support Activities"
          value={repeatedThisPeriod}
          tone={repeatedThisPeriod > 0 ? "warning" : "neutral"}
        />
        <StatTile
          label="Avg Resolution Time"
          value={avgResolutionSeconds !== null ? formatDurationShort(avgResolutionSeconds) : "—"}
          hint={`${periodLabel} completed sessions`}
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
          <div className="flex gap-2">
            <ButtonLink href={`/api/support-activity/export?type=activities&format=csv&${exportParams}`}>
              <Download className="size-3.5" aria-hidden />
              Export CSV
            </ButtonLink>
            <ButtonLink href={`/api/support-activity/export?type=activities&format=xlsx&${exportParams}`}>
              <Download className="size-3.5" aria-hidden />
              Export Excel
            </ButtonLink>
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
                  <Td>
                    {a.actor === "AI" ? (
                      <Badge color="blue" dot>
                        AI
                      </Badge>
                    ) : (
                      (a.teamMemberName ?? "—")
                    )}
                  </Td>
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
