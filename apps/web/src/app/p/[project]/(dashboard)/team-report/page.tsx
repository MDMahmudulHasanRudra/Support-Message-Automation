import { Download } from "lucide-react";
import {
  Alert,
  ButtonLink,
  Card,
  EmptyState,
  HelpButton,
  HelpSection,
  PageHeader,
  StatTile,
} from "@/components/ui";
import { ChartCard, ColumnChart, StackedBar } from "@/components/charts";
import { requireAccess } from "@/server/authorize";
import { formatDurationShort } from "@/lib/duration";
import {
  bucketLabel,
  loadTeamReport,
  memberLabel,
  parseTeamReportFilters,
  resolveTeamReportRange,
  scopeLabel,
  teamReportQuery,
} from "@/server/teamReport";
import { TeamReportFilters } from "./TeamReportFilters";
import { ReportDataTable } from "./ReportDataTable";
import { buildBucketsTable, buildGroupsTable, buildMembersTable } from "@/server/teamReportTables";
import { loadReportFilterOptions } from "@/server/reports/context";
import { presetLinks } from "@/server/reports/presets";
import { loadDataHealth } from "@/server/dataHealth";
import { DataHealthStrip } from "@/components/reports/DataHealthStrip";

export const metadata = { title: "Team Report" };

const when = (ms: number | null) =>
  ms === null
    ? "—"
    : new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Dhaka",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(ms));

const count = (n: number) => n.toLocaleString("en-US");
const duration = (seconds: number) => formatDurationShort(seconds);

export default async function TeamReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireAccess("support_activity.view");
  const params = await searchParams;
  const now = new Date();
  const requested = parseTeamReportFilters(params, now);
  const requestedRange = resolveTeamReportRange(requested, now);
  const [report, filterOptions, dataHealth] = await Promise.all([
    loadTeamReport(requested, now),
    loadReportFilterOptions(requested.groupKeys),
    loadDataHealth({ periodStart: requestedRange.start.getTime(), periodEnd: requestedRange.end.getTime(), now, accountId: requested.accountId }),
  ]);
  const { filters, range, result, memberNames, members, rules, teams, teamMemberIds, teamName, filterNote } = report;
  const { summary } = result;

  const scopedName = filters.memberId ? memberLabel(filters.memberId, memberNames) : null;
  const scope = scopeLabel(teamName, scopedName);
  const teamOnly = Boolean(filters.teamId && !filters.memberId);
  const PERIOD_NAMES: Record<string, string> = { day: "Daily", week: "Weekly", month: "Monthly", custom: "Custom range" };
  const query = teamReportQuery(filters);

  const activitySeries = result.buckets.map((b) => ({
    label: bucketLabel(b.key, filters.granularity),
    value: b.memberMessages + b.businessReplies,
  }));
  const durationSeries = result.buckets.map((b) => ({
    label: bucketLabel(b.key, filters.granularity),
    value: Math.round((b.activeSeconds / 3600) * 10) / 10,
  }));
  const labelEvery = Math.max(1, Math.ceil(result.buckets.length / 10));

  return (
    <div>
      <PageHeader
        title="Team Report"
        description={`${scope} · ${range.label}. Built from the WhatsApp messages the system stored — nothing here is entered by hand.`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <ButtonLink href={`/api/team-report/export?${query}&format=csv`}>
              <Download className="size-3.5" aria-hidden />
              CSV
            </ButtonLink>
            <ButtonLink href={`/api/team-report/export?${query}&format=xlsx`}>
              <Download className="size-3.5" aria-hidden />
              Excel (full report)
            </ButtonLink>
            <HelpButton moduleTitle="Team Report">
              <CalculationHelp idleGapMinutes={rules.idleGapMinutes} missedAfterMinutes={rules.missedAfterMinutes} policyMinutes={rules.policyMinutes} />
            </HelpButton>
          </div>
        }
      />

      <Card className="mb-5 p-4">
        <TeamReportFilters
          period={filters.period}
          date={filters.date}
          from={filters.from}
          to={filters.to}
          memberId={filters.memberId}
          teamId={filters.teamId}
          granularity={filters.granularity}
          members={members}
          teams={teams}
          teamMemberIds={teamMemberIds}
          presets={presetLinks("/team-report", filters, now)}
          groupOptions={filterOptions.groups}
          groupKeys={filters.groupKeys}
          accounts={filterOptions.accounts}
          accountId={filters.accountId}
        />
      </Card>

      {/* What the numbers below are about, in one line — also what a screenshot or export carries. */}
      <p className="mb-4 flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-[color:var(--color-muted-foreground)]">
        <span>
          Showing: <strong className="font-medium text-[color:var(--color-foreground)]">{scope}</strong>
        </span>
        <span>
          Period: <strong className="font-medium text-[color:var(--color-foreground)]">{PERIOD_NAMES[filters.period]} · {range.label}</strong>
        </span>
        {filters.groupKeys?.length ? (
          <span>
            Groups: <strong className="font-medium text-[color:var(--color-foreground)]">{filters.groupKeys.length}</strong> (only messages in these)
          </span>
        ) : null}
        {filters.accountId ? (
          <span>
            Account:{" "}
            <strong className="font-medium text-[color:var(--color-foreground)]">
              {filterOptions.accounts.find((a) => a.id === filters.accountId)?.label ?? "Unknown account"}
            </strong>
          </span>
        ) : null}
        {filters.teamId ? (
          <span>
            Members in team: <strong className="font-medium text-[color:var(--color-foreground)]">{teamMemberIds[filters.teamId]?.length ?? 0}</strong>
          </span>
        ) : null}
      </p>

      <DataHealthStrip health={dataHealth} />

      {filterNote ? (
        <div className="mb-5">
          <Alert tone="info">{filterNote}</Alert>
        </div>
      ) : null}

      {range.note ? (
        <div className="mb-5">
          <Alert tone="warning">{range.note}</Alert>
        </div>
      ) : null}

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile
          label="Groups supported"
          value={count(summary.groupsSupported)}
          hint={filters.memberId ? "groups they replied in" : teamOnly ? "groups the team replied in" : "groups that got a reply"}
        />
        <StatTile
          label="Customer messages"
          value={count(summary.customerMessages)}
          hint={filters.memberId ? "in the groups they supported" : teamOnly ? "in the groups the team supported" : "from customers, all groups"}
        />
        <StatTile
          label="Team replies"
          value={count(summary.memberReplies)}
          hint={
            filters.memberId
              ? "messages they sent"
              : teamOnly
                ? "messages the team's members sent"
                : `+ ${count(summary.businessReplies)} from the business number`
          }
        />
        <StatTile
          label="Support Overtime"
          value={duration(summary.activeSeconds)}
          hint={filters.memberId ? "active time, one timeline" : `${summary.activeMembers} member(s), summed`}
        />
        <StatTile
          label="Missed"
          value={count(summary.missed)}
          tone={summary.missed > 0 ? "warning" : "neutral"}
          hint={`${count(summary.unrecovered)} never answered`}
        />
        <StatTile label="Recall support" value={count(summary.recalled)} hint="missed, then answered" tone="accent" />
        <StatTile label="Customer waits" value={count(summary.waits)} hint="conversations that needed a reply" />
        <StatTile
          label="Last activity"
          value={when(summary.lastActivityAt)}
          hint={filters.memberId ? "their most recent message" : teamOnly ? `most recent ${teamName} message` : "most recent team message"}
        />
      </div>

      {summary.waits === 0 && summary.memberReplies === 0 && summary.customerMessages === 0 ? (
        <EmptyState>No WhatsApp group messages were stored for {scopedName ?? teamName ?? "the team"} in {range.label}.</EmptyState>
      ) : (
        <>
          <section className="mb-5 grid grid-cols-1 gap-3.5 lg:grid-cols-3">
            <ChartCard className="lg:col-span-2" title="Support activity" description={`Team replies per ${filters.granularity}.`}>
              <ColumnChart data={activitySeries} ariaLabel="Team replies over the period" labelEvery={labelEvery} />
            </ChartCard>
            <ChartCard title="Missed and recall" description="Of the customer waits that went past their threshold.">
              <StackedBar
                segments={[
                  { key: "recalled", label: "Answered late (recall)", value: summary.recalled, color: "var(--chart-1)" },
                  { key: "unrecovered", label: "Never answered", value: summary.unrecovered, color: "var(--color-danger)" },
                ]}
                total={summary.missed}
                ariaLabel="Missed customer waits, split into recalled and never answered"
                emptyMessage="Nothing was missed in this period."
              />
            </ChartCard>
            <ChartCard className="lg:col-span-3" title="Support Overtime" description={`Support Overtime hours per ${filters.granularity}.`}>
              <ColumnChart data={durationSeries} ariaLabel="Support Overtime hours over the period" unitLabel="h" labelEvery={labelEvery} />
            </ChartCard>
          </section>

          {!filters.memberId ? (
            <Card className="mb-5">
              <ReportDataTable
                table={buildMembersTable(report)}
                query={query}
                noun={{ singular: "team member", plural: "team members" }}
                title={teamName ? `${teamName} members` : "Team members"}
                description={
                  teamName
                    ? "Only their work while in this team. Missed belongs to the group's assigned member; Recall to whoever answered late. Select a name for that person's report."
                    : "Missed belongs to the group's assigned member; Recall to whoever answered late. Select a name for that person's report."
                }
              />
            </Card>
          ) : null}

          <Card className="mb-5">
            <ReportDataTable
              table={buildBucketsTable(report)}
              query={query}
              noun={
                filters.granularity === "day"
                  ? { singular: "day", plural: "days" }
                  : filters.granularity === "week"
                    ? { singular: "week", plural: "weeks" }
                    : { singular: "month", plural: "months" }
              }
              title={`By ${filters.granularity}`}
              description="The same figures, split over the period."
            />
          </Card>

          <Card>
            <ReportDataTable
              table={buildGroupsTable(report)}
              query={query}
              noun={{ singular: "group", plural: "groups" }}
              title={`Groups (${count(result.groups.length)})`}
              description={
                filters.memberId || filters.teamId
                  ? `Groups ${scopedName ?? teamName} replied in. Replies, time and first/last are theirs; Missed and Recall are the group's own. Select a group to see every wait behind its numbers.`
                  : "Every group with a message in the period, busiest first. Select a group to see every wait behind its numbers."
              }
            />
          </Card>
        </>
      )}
    </div>
  );
}

/** The calculation rules, in the words the report uses. Mirrors packages/shared/src/teamReport.ts. */
function CalculationHelp({
  idleGapMinutes,
  missedAfterMinutes,
  policyMinutes,
}: {
  idleGapMinutes: number;
  missedAfterMinutes: number;
  policyMinutes: Record<string, number>;
}) {
  const policies = Object.entries(policyMinutes);
  return (
    <>
      <HelpSection title="Where the numbers come from">
        <p>
          Every figure is counted from the WhatsApp group messages the system stored. A message is a customer message, a
          team member&apos;s message (matched by their WhatsApp id or phone number on Internal Team Members), or a
          business-number message (sent from our own number — an operator, a rule or the AI). A message stored by two of
          our numbers in the same group is counted once. Days, weeks (Sunday start) and months are Asia/Dhaka.
        </p>
      </HelpSection>
      <HelpSection title="Customer waits">
        <p>
          A customer message starts a wait when the message before it in that group was a reply, or there was none — so
          four lines in a row are one wait. The wait ends at the next reply from a team member or the business number.
          Only waits that start inside the period count; a reply is looked for up to a day after it ends.
        </p>
      </HelpSection>
      <HelpSection title="Missed and Recall">
        <p>
          A wait is <strong>Missed</strong> when nobody replied within {missedAfterMinutes} minutes
          {policies.length > 0 ? ` (or within the group's escalation first-alert time for prioritised groups: ${policies.map(([p, m]) => `${p} ${m} min`).join(", ")})` : ""}.
          It is <strong>Recall</strong> when somebody replied after that. Recall is part of Missed, never counted twice;
          Missed minus Recall is what was never answered. A wait still inside its time is neither yet. Change the time in
          Settings → Support Activity Setup.
        </p>
        <p className="mt-2">
          A Missed wait is charged to the group&apos;s assigned team member (&quot;Unassigned&quot; when it has none). A
          Recall is credited to whoever sent the late reply.
        </p>
      </HelpSection>
      <HelpSection title="Support Overtime">
        <p>
          Each member&apos;s messages across all groups form one timeline. A new stretch of work starts after more than{" "}
          {idleGapMinutes} minutes without a message (the &quot;Offline after&quot; setting Team Performance uses) and at
          every midnight. Support Overtime adds up first-to-last message of each stretch, so two groups answered at the same time
          count once. A stretch with a single message is zero. The team figure is the sum of members; group rows measure
          each group on its own, so they can add up to more.
        </p>
      </HelpSection>
    </>
  );
}
