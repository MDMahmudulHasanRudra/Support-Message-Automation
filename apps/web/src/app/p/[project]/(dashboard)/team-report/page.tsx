import { Download } from "lucide-react";
import {
  Alert,
  ButtonLink,
  Card,
  EmptyState,
  HelpButton,
  HelpSection,
  PageHeader,
  SectionHeader,
  StatTile,
} from "@/components/ui";
import { ChartCard, ColumnChart, StackedBar } from "@/components/charts";
import { requireAccess } from "@/server/authorize";
import { prisma } from "@/server/db";
import { formatDurationShort } from "@/lib/duration";
import {
  bucketLabel,
  CONTEXT_MS,
  LOOKAHEAD_MS,
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
import {
  buildReportRunMetadata,
  computeReportingReliability,
  countOperatorReplies,
  dataQualityLines,
  REPLY_ATTRIBUTION_VERSION,
  type DataQualityCounts,
} from "@support-automation/shared";
import { loadDataQualityCounts, loadPendingReattributions, resolvePageScope, withReportScope } from "@/server/unifiedReporting";
import { activeDisabledFeatures } from "@/server/projectFeatures";
import { loadPersonalReport } from "@/server/personalReport";
import { combinedLines } from "@/server/combinedReport";
import { customerSpecificReplies } from "@/server/replyAttribution";
import { CustomerSpecificReplies } from "./CustomerSpecificReplies";
import { mergeReliabilityCounts } from "@/server/scopedExport";
import { ReliabilitySection } from "./ReliabilitySection";
import { RunInformation } from "./RunInformation";
import { PersonalReportSections } from "./PersonalReportSections";
import { CombinedSummaryTable } from "./CombinedSummaryTable";
import { EmployeePerformance } from "./EmployeePerformance";
import { analyticsOf, buildComparisonTable, buildRankingTable, loadPreviousPeriod } from "@/server/employeePerformance";

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
  const session = await requireAccess("support_activity.view");
  const params = await searchParams;
  const now = new Date();
  // Unified messaging reports (UNIFIED_REPORTING): off, the page is exactly what it always was. Personal and
  // combined need `messages.view` on top; without it (or with the feature off) the scope is group.
  const { scope: pageScope, note: scopeNote, enabled: unified, canViewPersonal } = await resolvePageScope(params, session);
  const requested = withReportScope(parseTeamReportFilters(params, now), pageScope);
  // `compare=1` is a unified-reporting option: with the feature off it is dropped here, so every link and export is the old one.
  if (!unified) delete requested.compare;
  const requestedRange = resolveTeamReportRange(requested, now);
  // A conversation links to WhatsApp Chat only where the viewer may open it (the feature on, `messages.view`).
  const linkToChat = canViewPersonal && !(await activeDisabledFeatures()).has("WHATSAPP_CHAT");
  if (pageScope === "personal") return PersonalPage({ requested, now, scopeNote, linkToChat, canViewPersonal });
  const [report, filterOptions, dataHealth, quality, pendingReattributions, personal] = await Promise.all([
    loadTeamReport(requested, now, undefined, {
      ...(pageScope === "combined" ? { keepHumanWaits: true } : {}),
      // The quote and mention evidence behind "Customer-specific replies"; off, the query is the old one.
      ...(unified ? { withReplyEvidence: true } : {}),
    }),
    loadReportFilterOptions(requested.groupKeys),
    loadDataHealth({ periodStart: requestedRange.start.getTime(), periodEnd: requestedRange.end.getTime(), now, accountId: requested.accountId }),
    unified
      ? loadDataQualityCounts({ kind: "GROUP", start: requestedRange.start, end: requestedRange.end, accountId: requested.accountId, groupKeys: requested.groupKeys })
      : Promise.resolve<DataQualityCounts | null>(null),
    unified ? loadPendingReattributions() : Promise.resolve(0),
    // Combined: the personal half beside the group one, never instead of it.
    pageScope === "combined" ? loadPersonalReport(requested, now) : Promise.resolve(null),
  ]);
  const { filters, range, result, memberNames, members, rules, teams, teamMemberIds, teamName, filterNote } = report;
  const { summary } = result;
  const reliability = computeReportingReliability(report.reliabilityCounts, dataHealth, {
    start: range.start.getTime(),
    end: range.end.getTime(),
    now: now.getTime(),
  });

  const attribution = unified ? customerSpecificReplies(report) : null;
  // Ranking, daily engagement and (opt-in) the previous period: derived from this same report. Off, nothing is read or drawn.
  const employee = unified ? analyticsOf(report) : null;
  const previousLoaded = unified && filters.compare ? await loadPreviousPeriod(report, now) : null;
  const comparison = previousLoaded
    ? {
        table: previousLoaded.previous && employee ? buildComparisonTable(employee, previousLoaded.previous.analytics, memberNames, filters) : null,
        label: previousLoaded.previous ? previousLoaded.previous.report.range.label : "",
        note: previousLoaded.note,
      }
    : null;
  const reliabilityWindow = { start: range.start.getTime(), end: range.end.getTime(), now: now.getTime() };
  const personalReliability = personal ? computeReportingReliability(personal.reliabilityCounts, dataHealth, reliabilityWindow) : null;
  const scopedName = filters.memberId ? memberLabel(filters.memberId, memberNames) : null;
  const scope = scopeLabel(teamName, scopedName);
  const PERIOD_NAMES: Record<string, string> = { day: "Daily", week: "Weekly", month: "Monthly", custom: "Custom range" };
  const runMeta =
    unified && quality
      ? buildReportRunMetadata({
          scope: pageScope,
          generatedAt: now.getTime(),
          period: {
            start: range.start.getTime(),
            end: range.end.getTime(),
            label: range.label,
            contextMs: CONTEXT_MS,
            lookaheadMs: LOOKAHEAD_MS,
            name: PERIOD_NAMES[filters.period] ?? filters.period,
          },
          filters: {
            team: teamName,
            member: scopedName,
            groupCount: filters.groupKeys?.length ?? 0,
            account: filters.accountId ? (filterOptions.accounts.find((a) => a.id === filters.accountId)?.label ?? "Unknown account") : null,
            granularity: filters.granularity,
          },
          health: dataHealth,
          reliability: personal ? computeReportingReliability(mergeReliabilityCounts(report.reliabilityCounts, personal.reliabilityCounts), dataHealth, reliabilityWindow) : reliability,
          operatorReplies: countOperatorReplies(personal ? [...report.messages, ...personal.messages] : report.messages, range.end.getTime()),
          pendingReattributions,
          replyAttributionVersion: attribution ? REPLY_ATTRIBUTION_VERSION : null,
        })
      : null;
  const teamOnly = Boolean(filters.teamId && !filters.memberId);
  // The page's own moment travels with every export, so the file says what the screen said.
  const query = `${teamReportQuery(filters)}&asof=${now.getTime()}`;

  const activitySeries = result.buckets.map((b) => ({
    label: bucketLabel(b.key, filters.granularity),
    value: b.memberMessages + b.businessReplies,
  }));
  // Overtime per bucket. A bucket with no recorded team work is drawn as "no data", never as a
  // confirmed zero; the tooltip states the exact duration rather than decimal hours.
  const overtimeSeries = result.buckets.map((b) => ({
    label: bucketLabel(b.key, filters.granularity),
    value: Math.round((b.overtimeSeconds / 3600) * 100) / 100,
    display: duration(b.overtimeSeconds),
    missing: b.memberMessages === 0,
  }));
  const labelEvery = Math.max(1, Math.ceil(result.buckets.length / 10));

  return (
    <div>
      <PageHeader
        title="Team Report"
        description={
          personal
            ? `${scope} · ${range.label}. Groups and personal chats — shown side by side. Combined figures add only what can be added; a customer who wrote in a group and in a personal chat is counted in both.`
            : `${scope} · ${range.label}. Built from the WhatsApp messages the system stored — nothing here is entered by hand.`
        }
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
              <CalculationHelp idleGapMinutes={rules.idleGapMinutes} missedAfterMinutes={rules.missedAfterMinutes} policyMinutes={rules.policyMinutes} unified={unified} />
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
          scopeChoice={unified && canViewPersonal ? pageScope : undefined}
          compareChoice={unified ? Boolean(filters.compare) : undefined}
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

      {runMeta ? <RunInformation meta={runMeta} /> : null}

      {scopeNote ? (
        <div className="mb-5">
          <Alert tone="info">{scopeNote}</Alert>
        </div>
      ) : null}

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
          hint={filters.memberId ? "in the groups they supported or were assigned" : teamOnly ? "in the groups the team supported or was assigned" : "from customers, all groups"}
        />
        <StatTile
          label="Team replies"
          value={count(summary.memberReplies)}
          hint={
            filters.memberId
              ? "messages they sent"
              : teamOnly
                ? "messages the team's members sent"
                : `+ ${count(summary.businessReplies)} from the business number${
                    summary.unattributedStaffReplies > 0
                      ? ` · ${count(summary.unattributedStaffReplies)} by a team member not identified (see Team Members)`
                      : ""
                  }`
          }
        />
        <StatTile
          label="Support Overtime"
          value={duration(summary.overtimeSeconds)}
          hint={filters.memberId ? "beyond regular duty, per day" : `${summary.activeMembers} member(s), each day beyond regular duty`}
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

      {summary.unscheduledMemberDays > 0 ? (
        <p className="mb-5 rounded-[var(--radius-md)] border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] px-4 py-2.5 text-[12px] leading-relaxed text-[color:var(--color-warning-fg)]">
          {count(summary.unscheduledMemberDays)} member-day(s) with work had no schedule — no roster entry, weekly pattern
          or default shift that applied on that date — so their overtime is measured against the project&apos;s default
          duty length. Fill the roster (Team → Roster) for exact figures; the default is in Settings → Support Activity
          Setup.
        </p>
      ) : null}

      {personal ? (
        <>
          <CombinedSummaryTable lines={combinedLines(report, personal)} />
          <SectionHeader title="Groups" description="WhatsApp groups: exactly the figures the group report shows." />
        </>
      ) : null}

      {summary.waits === 0 && summary.memberReplies === 0 && summary.customerMessages === 0 ? (
        <EmptyState>
          {scopedName || teamName
            ? `Nothing in ${range.label} for ${scopedName ?? teamName}: no replies of theirs, and no wait in a group they were answerable for.`
            : `No WhatsApp group messages were stored in ${range.label}.`}
        </EmptyState>
      ) : (
        <>
          <section className="mb-5 grid grid-cols-1 gap-3.5 lg:grid-cols-3">
            <ChartCard className="lg:col-span-2" title="Support activity" description={`Replies per ${filters.granularity}: team members and the business number.`}>
              <ColumnChart data={activitySeries} ariaLabel="Replies over the period" labelEvery={labelEvery} />
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
            <ChartCard
              className="lg:col-span-3"
              title="Support Overtime"
              description={`Support time beyond regular duty, per ${filters.granularity}. A hatched bar: no team work was recorded.`}
            >
              <ColumnChart data={overtimeSeries} ariaLabel="Support Overtime per period" unitLabel="overtime" labelEvery={labelEvery} />
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
                    ? "Only their work while in this team. Missed belongs to whoever the group was assigned to when the customer asked; Recall to whoever answered late. Select a name for that person's report."
                    : "Missed belongs to whoever the group was assigned to when the customer asked; Recall to whoever answered late. Select a name for that person's report."
                }
              />
            </Card>
          ) : null}

          {employee ? (
            <EmployeePerformance
              report={report}
              analytics={employee}
              query={query}
              ranking={filters.memberId ? null : buildRankingTable(report, employee)}
              comparison={comparison}
            />
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
                  ? `Groups ${scopedName ?? teamName} replied in, or was the assignee of when a customer asked. Replies, time and first/last are theirs; Missed and Recall are the group's own. Select a group to see every wait behind its numbers.`
                  : "Every group with a message in the period, busiest first. Select a group to see every wait behind its numbers."
              }
            />
          </Card>
        </>
      )}

      {attribution ? <CustomerSpecificReplies attribution={attribution} /> : null}

      <ReliabilitySection
        response={report.response}
        reliability={reliability}
        extraLines={unified && quality ? dataQualityLines(quality, "GROUP", pendingReattributions) : undefined}
      />

      {personal && personalReliability ? (
        <div className="mt-8">
          <SectionHeader title="Personal chats" description="One-to-one chats, computed on their own and shown beside the groups." />
          <PersonalReportSections data={personal} query={query} linkToChat={linkToChat} />
          <h2 className="mt-8 text-[15px] font-semibold text-[color:var(--color-foreground)]">Personal chats: who answered, and reliability</h2>
          <ReliabilitySection
            response={personal.result.response}
            reliability={personalReliability}
            extraLines={dataQualityLines(personal.dataQuality, "PERSONAL", pendingReattributions)}
          />
        </div>
      ) : null}
    </div>
  );
}

/** The calculation rules, in the words the report uses. Mirrors packages/shared/src/teamReport.ts. */
function CalculationHelp({
  idleGapMinutes,
  missedAfterMinutes,
  policyMinutes,
  unified = false,
}: {
  idleGapMinutes: number;
  missedAfterMinutes: number;
  policyMinutes: Record<string, number>;
  /** UNIFIED_REPORTING on: the scope-aware wording and the extra sections. Off, the help is what it always was. */
  unified?: boolean;
}) {
  const policies = Object.entries(policyMinutes);
  return (
    <>
      <HelpSection title="Where the numbers come from">
        <p>
          Every figure is counted from the WhatsApp group messages the system stored. A message is a customer message, a
          team member&apos;s message (matched by their WhatsApp id or phone number on Internal Team Members), or a
          business-number message (sent from our own number — an operator, a rule or the AI). A message stored by two of
          our numbers in the same group is counted once, and every stored copy is used to recognise who sent it. A reply
          typed in WhatsApp Chat counts for the team member linked to that login on Team Members. Days, weeks (Sunday
          start) and months are Asia/Dhaka.
        </p>
        {unified ? (
          <p className="mt-2">
            Group figures count only WhatsApp groups. One-to-one (personal) chats are reported separately: choose
            &quot;Personal chats&quot; or &quot;Both&quot; above (it needs the View Messages permission).
          </p>
        ) : (
          <p className="mt-2">
            One-to-one (personal) chats are not counted here: this report is about support in groups. Personal
            conversations are in WhatsApp Chat and the WhatsApp Chat User Activity report.
          </p>
        )}
      </HelpSection>
      {unified ? <UnifiedHelp missedAfterMinutes={missedAfterMinutes} /> : null}
      <HelpSection title="Customer waits">
        <p>
          A customer message starts a wait when the message before it in that group was a reply, or there was none — so
          four lines in a row are one wait. The wait ends at the next reply from a team member or the business number —
          and a business-number reply includes the AI&apos;s and an automation rule&apos;s, so an automated answer ends a
          wait here. Only waits that start inside the period count; a reply is looked for up to a day after it ends, and
          the hours before the period are read only to see whether a wait was already open at its start, so a month&apos;s
          waits are the sum of its days&apos;.
        </p>
      </HelpSection>
      <HelpSection title="Who answered, and the human response">
        <p>
          Below the report, every answered wait is split by who sent the reply that ended it: a verified person (a team
          member on their own WhatsApp, or someone signed in to this dashboard), the AI, an automation rule, the business
          number (a broadcast, or a message sent from the phone and not by this system), or a team member the roster
          cannot name. That comes from the send each reply echoes, never from its direction.
        </p>
        <p className="mt-2">
          The <strong>first human response</strong> is Human Response SLA&apos;s wait: only a person&apos;s reply ends it,
          and a closing remark such as &quot;thanks&quot; does not start one. Its time is measured to a verified person.
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
          A Missed wait is charged to the team member the group was assigned to when the customer asked
          (&quot;Unassigned&quot; when it had none) — reassigning a group later does not move it. A Recall is credited to
          whoever sent the late reply.
        </p>
      </HelpSection>
      <HelpSection title="Support Overtime">
        <p>
          Support Overtime is support time <strong>beyond the person&apos;s regular duty</strong>, worked out for each
          day on its own and then added up — a long day is never netted against a short one. Only overtime is shown.
        </p>
        <p className="mt-2">
          Support time comes from WhatsApp messages: each member&apos;s messages across all groups form one timeline, and a
          new stretch of work starts after more than {idleGapMinutes} minutes without a message (the &quot;Offline
          after&quot; setting) and at every midnight. Each stretch counts first-to-last message, so two groups answered at
          once count once, and silence is never counted as work. It is what message timestamps show, not verified
          working hours.
        </p>
        <p className="mt-2">
          Regular duty for a day is, in order: that date&apos;s roster entry; nothing on a day off, leave, a holiday or
          extra duty (all of that day&apos;s support time is overtime); the weekly pattern; the default shift; otherwise
          the project&apos;s default duty length. A weekly pattern or default shift is used for a date only if it was
          already set then. Work after midnight inside an overnight shift belongs to the day the shift began.
        </p>
        <p className="mt-2">
          Group rows show <strong>support time</strong> in that group, measured on its own — overtime belongs to a
          person&apos;s day, not to a group.
        </p>
      </HelpSection>
    </>
  );
}

const PERIOD_LABELS: Record<string, string> = { day: "Daily", week: "Weekly", month: "Monthly", custom: "Custom range" };

/**
 * `scope=personal` (UNIFIED_REPORTING): the same Team Report for one-to-one chats. Same filters, same
 * data-health strip and reliability section, personal figures — never a group row. Reached only when the
 * feature is on and the viewer holds `messages.view` (`resolvePageScope`).
 */
async function PersonalPage({
  requested,
  now,
  scopeNote,
  linkToChat,
  canViewPersonal,
}: {
  requested: ReturnType<typeof parseTeamReportFilters>;
  now: Date;
  scopeNote: string | null;
  linkToChat: boolean;
  canViewPersonal: boolean;
}) {
  const requestedRange = resolveTeamReportRange(requested, now);
  const [data, accounts, dataHealth, pendingReattributions] = await Promise.all([
    loadPersonalReport(requested, now),
    // Accounts only: the group list is a group-report filter and personal chats have none.
    prisma.whatsAppAccount.findMany({ select: { id: true, label: true, phoneNumber: true }, orderBy: [{ isPrimary: "desc" }, { label: "asc" }] }),
    loadDataHealth({ periodStart: requestedRange.start.getTime(), periodEnd: requestedRange.end.getTime(), now, accountId: requested.accountId }),
    loadPendingReattributions(),
  ]);
  const { filters, range, memberNames, teamName } = data;
  const reliability = computeReportingReliability(data.reliabilityCounts, dataHealth, { start: range.start.getTime(), end: range.end.getTime(), now: now.getTime() });
  const scopedName = filters.memberId ? memberLabel(filters.memberId, memberNames) : null;
  const scope = scopeLabel(teamName, scopedName);
  const accountLabel = filters.accountId ? (accounts.find((a) => a.id === filters.accountId)?.label ?? "Unknown account") : null;
  const runMeta = buildReportRunMetadata({
    scope: "personal",
    generatedAt: now.getTime(),
    period: {
      start: range.start.getTime(),
      end: range.end.getTime(),
      label: range.label,
      contextMs: CONTEXT_MS,
      lookaheadMs: LOOKAHEAD_MS,
      name: PERIOD_LABELS[filters.period] ?? filters.period,
    },
    filters: { team: teamName, member: scopedName, groupCount: 0, account: accountLabel, granularity: filters.granularity },
    health: dataHealth,
    reliability,
    operatorReplies: countOperatorReplies(data.messages, range.end.getTime()),
    pendingReattributions,
  });
  const query = `${teamReportQuery(filters)}&asof=${now.getTime()}`;

  return (
    <div>
      <PageHeader
        title="Team Report — personal chats"
        description={`${scope} · ${range.label}. One-to-one chats only, counted from the messages the system stored. No message text is shown here.`}
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
              <CalculationHelp idleGapMinutes={0} missedAfterMinutes={data.rules.missedAfterMinutes} policyMinutes={{}} unified />
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
          members={data.members}
          teams={data.teams}
          teamMemberIds={data.teamMemberIds}
          presets={presetLinks("/team-report", filters, now)}
          accounts={accounts}
          accountId={filters.accountId}
          scopeChoice={canViewPersonal ? "personal" : undefined}
        />
      </Card>

      <p className="mb-4 flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-[color:var(--color-muted-foreground)]">
        <span>
          Showing: <strong className="font-medium text-[color:var(--color-foreground)]">Personal chats · {scope}</strong>
        </span>
        <span>
          Period: <strong className="font-medium text-[color:var(--color-foreground)]">{PERIOD_LABELS[filters.period]} · {range.label}</strong>
        </span>
        {accountLabel ? (
          <span>
            Account: <strong className="font-medium text-[color:var(--color-foreground)]">{accountLabel}</strong>
          </span>
        ) : null}
      </p>

      <DataHealthStrip health={dataHealth} />

      <RunInformation meta={runMeta} />

      {scopeNote ? (
        <div className="mb-5">
          <Alert tone="info">{scopeNote}</Alert>
        </div>
      ) : null}
      {data.filterNote ? (
        <div className="mb-5">
          <Alert tone="info">{data.filterNote}</Alert>
        </div>
      ) : null}
      {range.note ? (
        <div className="mb-5">
          <Alert tone="warning">{range.note}</Alert>
        </div>
      ) : null}

      <PersonalReportSections data={data} query={query} linkToChat={linkToChat} />

      <ReliabilitySection response={data.result.response} reliability={reliability} extraLines={dataQualityLines(data.dataQuality, "PERSONAL", pendingReattributions)} />
    </div>
  );
}

/** The help sections that only exist with UNIFIED_REPORTING on. */
function UnifiedHelp({ missedAfterMinutes }: { missedAfterMinutes: number }) {
  return (
    <>
      <HelpSection title="Personal chats">
        <p>
          A personal chat is a one-to-one WhatsApp chat, with a phone number or one WhatsApp hides. It belongs to the
          account that holds its messages, so the same customer writing to two of our numbers is two conversations, and a
          customer who appears once with a number and once with a hidden id is two as well. A wait is the same wait as in
          groups. A personal chat has no priority, so it is Missed after {missedAfterMinutes} minutes (Settings → Support
          Activity Setup), and nobody is charged with it.
        </p>
        <p className="mt-2">
          Only a dashboard reply by a login linked to a team member is credited to a person here. A team member writing
          from their own phone makes the chat an internal one, which is left out, and so is a chat between two of our
          own numbers. Replies from the AI, a rule or the business phone are counted as the business&apos;s. With a Team or
          member chosen, the report covers the conversations that member answered; the group filter does not apply.
        </p>
      </HelpSection>
      <HelpSection title="Groups and personal together">
        <p>
          Both reports are computed on their own and set side by side. Figures that can be added are added; the median
          is recalculated over every wait in both, never averaged; support time and overtime are group figures only; a
          distinct-customer count is not offered, because the same person can be a phone number in one chat and a hidden
          id in the other.
        </p>
      </HelpSection>
      <HelpSection title="Customer-specific replies">
        <p>
          In a group, the wait above is the group&apos;s: somebody replied. The section below the groups asks, beside it,
          which customer each reply answered — and only counts it when the conversation says so: the reply quotes the
          customer&apos;s message, @-mentions the customer, or that customer was the only one waiting and nobody else wrote
          since. A reply none of those places is shown as not linked; that is not evidence the customer was ignored. A
          customer is the same person whether seen as a phone number or a hidden id. Nothing here is guessed or
          AI-suggested, and nothing changes a figure above.
        </p>
      </HelpSection>
      <HelpSection title="Ranking, daily engagement and comparison">
        <p>
          <strong>Ranking by measure</strong> ranks every member on each measure on its own: groups engaged (distinct groups
          with their messages in the period), replies, active days (Dhaka days with any message), average groups per active
          day, support time, Missed charged to them (fewer is better) and the median response time on the waits their reply
          closed (shorter is better). There is no overall score. A person with fewer than 3 active days (fewer when the
          period is shorter), or fewer than 5 closed waits for the response time, shows &quot;Not enough data&quot; and is
          not ranked last. Ties share a rank. The top 3 and the 3 furthest behind are tinted.
        </p>
        <p className="mt-2">
          <strong>Daily engagement</strong> is the distinct groups each person engaged on each day. The row total is the
          distinct groups over the period; the sum of days is shown beside it, because a group worked on three days counts
          three times there and once in the distinct total. Both come from the same messages as the Team members table, so
          for a one-day period the two agree.
        </p>
        <p className="mt-2">
          <strong>Compare with the previous period</strong> loads the period of equal length just before this one with the
          same filters and shows groups engaged, replies, active days, support time and Missed, before and now.
        </p>
      </HelpSection>
      <HelpSection title="Run information">
        <p>
          The panel under the header says what this run was computed from: the calculation version, the moment and the
          data cutoff, the period and the context read around it, how senders are identified, and counts of collection
          and identity quality. The Excel file carries the same lines. They are counts, never a score.
        </p>
      </HelpSection>
    </>
  );
}
