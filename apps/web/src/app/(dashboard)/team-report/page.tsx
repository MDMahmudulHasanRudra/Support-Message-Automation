import Link from "next/link";
import { Download } from "lucide-react";
import {
  Alert,
  ButtonLink,
  Card,
  EmptyState,
  HelpButton,
  HelpSection,
  PageHeader,
  Pagination,
  SectionHeader,
  StatTile,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { ChartCard, ColumnChart, StackedBar } from "@/components/charts";
import { requireAccess } from "@/server/authorize";
import { formatDurationShort } from "@/lib/duration";
import {
  bucketLabel,
  loadTeamReport,
  memberLabel,
  parseTeamReportFilters,
  teamReportQuery,
} from "@/server/teamReport";
import { TeamReportFilters } from "./TeamReportFilters";

export const metadata = { title: "Team Report" };

const GROUPS_PER_PAGE = 50;

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
const duration = (seconds: number) => (seconds > 0 ? formatDurationShort(seconds) : "0m");

export default async function TeamReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireAccess("support_activity.view");
  const params = await searchParams;
  const now = new Date();
  const filters = parseTeamReportFilters(params, now);
  const { range, result, memberNames, members, groups, rules } = await loadTeamReport(filters, now);
  const { summary } = result;

  const scopedName = filters.memberId ? memberLabel(filters.memberId, memberNames) : null;
  const query = teamReportQuery(filters);
  const page = Math.max(1, Number(params.page ?? "1") || 1);
  const pagedGroups = result.groups.slice((page - 1) * GROUPS_PER_PAGE, page * GROUPS_PER_PAGE);

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
        description={`${scopedName ?? "All team members"} · ${range.label}. Built from the WhatsApp messages the system stored — nothing here is entered by hand.`}
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
          granularity={filters.granularity}
          members={members}
        />
      </Card>

      {range.note ? (
        <div className="mb-5">
          <Alert tone="warning">{range.note}</Alert>
        </div>
      ) : null}

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Groups supported" value={count(summary.groupsSupported)} hint={filters.memberId ? "groups they replied in" : "groups that got a reply"} />
        <StatTile label="Customer messages" value={count(summary.customerMessages)} hint={filters.memberId ? "in the groups they supported" : "from customers, all groups"} />
        <StatTile
          label="Team replies"
          value={count(summary.memberReplies)}
          hint={filters.memberId ? "messages they sent" : `+ ${count(summary.businessReplies)} from the business number`}
        />
        <StatTile
          label="Support duration"
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
        <StatTile label="Last activity" value={when(summary.lastActivityAt)} hint="most recent team message" />
      </div>

      {summary.waits === 0 && summary.memberReplies === 0 && summary.customerMessages === 0 ? (
        <EmptyState>No WhatsApp group messages were stored for {scopedName ?? "the team"} in {range.label}.</EmptyState>
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
            <ChartCard className="lg:col-span-3" title="Support duration" description={`Active support hours per ${filters.granularity}.`}>
              <ColumnChart data={durationSeries} ariaLabel="Support hours over the period" unitLabel="h" labelEvery={labelEvery} />
            </ChartCard>
          </section>

          {!filters.memberId ? (
            <Card className="mb-5">
              <SectionHeader
                title="Team members"
                description="Missed belongs to the group's assigned member; Recall to whoever answered late. Select a name for that person's report."
              />
              <Table>
                <thead>
                  <tr>
                    <Th>Team member</Th>
                    <Th>Groups</Th>
                    <Th>Replies</Th>
                    <Th>Customer msgs</Th>
                    <Th>Missed</Th>
                    <Th>Recall</Th>
                    <Th>Support time</Th>
                    <Th>First – last</Th>
                  </tr>
                </thead>
                <tbody>
                  {result.members.map((row) => (
                    <tr key={row.memberId}>
                      <Td>
                        {row.memberId === "UNASSIGNED" ? (
                          <span className="text-[color:var(--color-muted-foreground)]">Unassigned groups</span>
                        ) : (
                          <Link className="link" href={`/team-report?${teamReportQuery(filters, { memberId: row.memberId })}`}>
                            {memberLabel(row.memberId, memberNames)}
                          </Link>
                        )}
                      </Td>
                      <Td className="tabular">{count(row.groups)}</Td>
                      <Td className="tabular">{count(row.messages)}</Td>
                      <Td className="tabular">{count(row.customerMessages)}</Td>
                      <Td className="tabular">{count(row.missed)}</Td>
                      <Td className="tabular">{count(row.recalled)}</Td>
                      <Td className="tabular">{duration(row.activeSeconds)}</Td>
                      <Td className="tabular text-[color:var(--color-muted-foreground)]">
                        {row.firstAt ? `${when(row.firstAt)} – ${when(row.lastAt)}` : "—"}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          ) : null}

          <Card className="mb-5">
            <SectionHeader title={`By ${filters.granularity}`} description="The same figures, split over the period." />
            <Table>
              <thead>
                <tr>
                  <Th>{filters.granularity === "day" ? "Date" : filters.granularity === "week" ? "Week" : "Month"}</Th>
                  <Th>Groups</Th>
                  <Th>Team replies</Th>
                  <Th>Customer msgs</Th>
                  <Th>Missed</Th>
                  <Th>Recall</Th>
                  <Th>Support time</Th>
                </tr>
              </thead>
              <tbody>
                {result.buckets.map((b) => (
                  <tr key={b.key}>
                    <Td>{bucketLabel(b.key, filters.granularity)}</Td>
                    <Td className="tabular">{count(b.groups)}</Td>
                    <Td className="tabular">{count(b.memberMessages + b.businessReplies)}</Td>
                    <Td className="tabular">{count(b.customerMessages)}</Td>
                    <Td className="tabular">{count(b.missed)}</Td>
                    <Td className="tabular">{count(b.recalled)}</Td>
                    <Td className="tabular">{duration(b.activeSeconds)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>

          <Card>
            <SectionHeader
              title={`Groups (${count(result.groups.length)})`}
              description={
                filters.memberId
                  ? `Groups ${scopedName} replied in. Replies, time and first/last are theirs; Missed and Recall are the group's own. Select a group to see every wait behind its numbers.`
                  : "Every group with a message in the period, busiest first. Select a group to see every wait behind its numbers."
              }
            />
            <Table>
              <thead>
                <tr>
                  <Th>Group</Th>
                  <Th>Assigned</Th>
                  <Th>Messages</Th>
                  <Th>Customer</Th>
                  <Th>Replies</Th>
                  <Th>Missed</Th>
                  <Th>Recall</Th>
                  <Th>First – last support</Th>
                  <Th>Support time</Th>
                </tr>
              </thead>
              <tbody>
                {pagedGroups.map((row) => {
                  const meta = groups.get(row.groupKey);
                  return (
                    <tr key={row.groupKey}>
                      <Td>
                        {meta ? (
                          <Link className="link" href={`/team-report/group/${meta.id}?${query}`}>
                            {meta.name}
                          </Link>
                        ) : (
                          row.groupKey
                        )}
                        <span className="block text-[11px] text-[color:var(--color-subtle-foreground)]">{row.groupKey}</span>
                      </Td>
                      <Td>{meta?.assignedMemberId ? memberLabel(meta.assignedMemberId, memberNames) : "—"}</Td>
                      <Td className="tabular">{count(row.totalMessages)}</Td>
                      <Td className="tabular">{count(row.customerMessages)}</Td>
                      <Td className="tabular">
                        {count(row.memberReplies)}
                        {row.businessReplies > 0 ? (
                          <span className="block text-[11px] text-[color:var(--color-subtle-foreground)]">+{count(row.businessReplies)} business</span>
                        ) : null}
                      </Td>
                      <Td className="tabular">{count(row.missed)}</Td>
                      <Td className="tabular">{count(row.recalled)}</Td>
                      <Td className="tabular text-[color:var(--color-muted-foreground)]">
                        {row.firstActivityAt ? `${when(row.firstActivityAt)} – ${when(row.lastActivityAt)}` : "—"}
                      </Td>
                      <Td className="tabular">{duration(row.activeSeconds)}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
            {result.groups.length > GROUPS_PER_PAGE ? (
              <Pagination
                page={page}
                pageSize={GROUPS_PER_PAGE}
                total={result.groups.length}
                buildHref={(p) => `/team-report?${teamReportQuery(filters, { page: p })}`}
              />
            ) : null}
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
      <HelpSection title="Support duration">
        <p>
          Each member&apos;s messages across all groups form one timeline. A new stretch of work starts after more than{" "}
          {idleGapMinutes} minutes without a message (the &quot;Offline after&quot; setting Team Performance uses) and at
          every midnight. Duration adds up first-to-last message of each stretch, so two groups answered at the same time
          count once. A stretch with a single message is zero. The team figure is the sum of members; group rows measure
          each group on its own, so they can add up to more.
        </p>
      </HelpSection>
    </>
  );
}
