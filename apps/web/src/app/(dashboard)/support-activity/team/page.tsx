import Link from "next/link";
import { Download } from "lucide-react";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { getDhakaDayRange, getSupportActivityPeriodRange } from "@/lib/supportActivityPeriod";
import { formatDurationShort } from "@/lib/duration";
import { getDailyHoursWorked, getPerTeamMemberBreakdown, getTeamAvailability } from "@/server/supportActivityReports";
import { Badge, ButtonLink, Card, EmptyState, HelpButton, HelpSection, PageHeader, SectionHeader, StatusDot, Table, Td, Th } from "@/components/ui";

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

  // Issues-handled/resolved — all-time (SupportIssue has no period concept yet in this P0 slice),
  // computed here rather than folded into getPerTeamMemberBreakdown() since it's a different data
  // source (SupportIssue, not SupportActivity) with a different time scope; keeping it a plain
  // page-level query avoids implying a period-scoped guarantee this doesn't actually provide.
  const issueCounts = await prisma.supportIssue.groupBy({
    by: ["supportExecutiveId", "status"],
    where: { supportExecutiveId: { in: breakdown.map((b) => b.teamMemberId) } },
    _count: { _all: true },
  });
  const issuesHandledByMember = new Map<string, number>();
  const issuesResolvedByMember = new Map<string, number>();
  for (const row of issueCounts) {
    const memberId = row.supportExecutiveId;
    if (!memberId) continue;
    issuesHandledByMember.set(memberId, (issuesHandledByMember.get(memberId) ?? 0) + row._count._all);
    if (row.status === "RESOLVED") {
      issuesResolvedByMember.set(memberId, (issuesResolvedByMember.get(memberId) ?? 0) + row._count._all);
    }
  }

  // "Today / Right Now" is always a daily/live snapshot, independent of the admin's configured
  // countingPeriod above — mixing it into the period-scoped table would misrepresent a
  // WEEKLY/MONTHLY-configured admin's daily figures as period-scoped.
  const todayRange = getDhakaDayRange(new Date());
  const [availability, hoursWorked] = await Promise.all([getTeamAvailability(), getDailyHoursWorked(todayRange)]);
  const hoursByMember = new Map(hoursWorked.map((h) => [h.teamMemberId, h.totalSeconds]));

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
          <div className="flex gap-2">
            <ButtonLink href={`/api/support-activity/export?type=team&format=csv&${exportParams}`}>
              <Download className="size-3.5" aria-hidden />
              Export CSV
            </ButtonLink>
            <ButtonLink href={`/api/support-activity/export?type=team&format=xlsx&${exportParams}`}>
              <Download className="size-3.5" aria-hidden />
              Export Excel
            </ButtonLink>
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
                <Th>Issues Handled</Th>
                <Th>Issues Resolved</Th>
              </tr>
            </thead>
            <tbody>
              {breakdown.map((row) => (
                <tr key={row.teamMemberId}>
                  <Td>{row.name}</Td>
                  <Td className="tabular-nums">{row.activityCount}</Td>
                  <Td className="tabular-nums">{issuesHandledByMember.get(row.teamMemberId) ?? 0}</Td>
                  <Td className="tabular-nums">{issuesResolvedByMember.get(row.teamMemberId) ?? 0}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card className="mt-6">
        <SectionHeader
          title="Today / Right Now"
          description="Always today's date and the current moment — not affected by the counting period above."
        />
        {availability.length === 0 ? (
          <EmptyState>No active support team members yet.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Member</Th>
                <Th>Working Today</Th>
                <Th>Available Now</Th>
                <Th>Hours Worked Today</Th>
              </tr>
            </thead>
            <tbody>
              {availability.map((row) => (
                <tr key={row.teamMemberId}>
                  <Td>{row.name}</Td>
                  <Td>
                    <Badge color={row.workingToday ? "green" : "gray"}>
                      {row.workingToday ? "Working today" : "Off today"}
                    </Badge>
                  </Td>
                  <Td>
                    <span className="inline-flex items-center gap-2">
                      <StatusDot color={row.availableNow ? "green" : "gray"} pulse={row.availableNow} />
                      {row.availableNow ? "Available now" : "Not available right now"}
                    </span>
                  </Td>
                  <Td className="tabular-nums">{formatDurationShort(hoursByMember.get(row.teamMemberId) ?? 0)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
