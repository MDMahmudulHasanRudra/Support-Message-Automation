/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */
import Link from "next/link";
import {
  Activity,
  Bell,
  Link2,
  ListChecks,
  Power,
  Send,
  ShieldAlert,
  Smartphone,
  Sparkles,
  Terminal as ConsoleIcon,
  Waypoints,
} from "lucide-react";
import { requireSession } from "@/server/auth";
import { formatDateTime } from "@/lib/date";
import {
  Alert,
  Badge,
  ButtonLink,
  Card,
  DashboardModuleCard,
  EmptyState,
  HelpButton,
  HelpSection,
  ModuleCardRow,
  PageHeader,
  SectionHeader,
  StatTile,
  Table,
  Td,
  Th,
} from "@/components/ui";
import type { ModuleHealthStatus } from "@/components/ui/DashboardModuleCard";
import { getGroupsAwaitingReply } from "@/server/supportActivityReports";
import {
  AreaChart,
  BarList,
  ChartCard,
  ChartHeadline,
  ColumnChart,
  DonutChart,
  StackedBar,
  formatCount,
} from "@/components/charts";
import {
  getAccountsRoutingSummary,
  getAiLearningSummary,
  getAutomationOutboundSummary,
  getBulkMessagingSummary,
  getConversationLearningSummary,
  getEscalationSummary,
  getNotificationsSummary,
  getRecentMessageActivity,
  getSupportActivityDashboardSummary,
  getSystemLogsSummary,
  getTeamsIntegrationSummary,
  getWorkerLivenessSummary,
} from "@/server/actions/dashboardSummary";
import {
  getAiOutcomeSeries,
  getBusiestGroups,
  getDecisionMix,
  getDeliveryOutcomes,
  getExecutiveLoad,
  getMessageLoadSeries,
  getResponseTimeSeries,
  getSupportActorMix,
} from "@/server/actions/dashboardMetrics";

const SYSTEM_STATUS_LABEL: Record<ModuleHealthStatus, string> = {
  OPERATIONAL: "Operational",
  ATTENTION: "Needs attention",
  DOWN: "Action required",
  OFF: "Not enabled",
};
const SYSTEM_STATUS_BADGE: Record<ModuleHealthStatus, "green" | "yellow" | "red" | "gray"> = {
  OPERATIONAL: "green",
  ATTENTION: "yellow",
  DOWN: "red",
  OFF: "gray",
};

function formatAgeShort(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export default async function OverviewPage() {
  await requireSession();

  // eslint-disable-next-line react-hooks/purity -- server component runs fresh per request; not subject to render-purity rules
  const nowMs = Date.now();

  const [
    accountsRouting,
    automationOutbound,
    escalation,
    conversationLearning,
    aiLearning,
    bulkMessaging,
    notifications,
    systemLogs,
    supportActivity,
    recentActivity,
    teamsIntegration,
    messageLoad,
    decisionMix,
    deliveryOutcomes,
    busiestGroups,
    aiOutcomes,
    responseTimes,
    actorMix,
    executiveLoad,
    awaiting,
    workerLiveness,
  ] = await Promise.all([
    getAccountsRoutingSummary(),
    getAutomationOutboundSummary(nowMs),
    getEscalationSummary(),
    getConversationLearningSummary(),
    getAiLearningSummary(),
    getBulkMessagingSummary(),
    getNotificationsSummary(nowMs),
    getSystemLogsSummary(nowMs),
    getSupportActivityDashboardSummary(nowMs),
    getRecentMessageActivity(nowMs),
    getTeamsIntegrationSummary(nowMs),
    getMessageLoadSeries(nowMs),
    getDecisionMix(nowMs),
    getDeliveryOutcomes(nowMs),
    getBusiestGroups(nowMs),
    getAiOutcomeSeries(nowMs),
    getResponseTimeSeries(nowMs),
    getSupportActorMix(nowMs),
    getExecutiveLoad(nowMs),
    getGroupsAwaitingReply(new Date(nowMs)),
    getWorkerLivenessSummary(nowMs),
  ]);

  const disconnectedAccounts = accountsRouting.accounts.filter((a) => a.status !== "CONNECTED");

  /**
   * One status per module card, derived entirely from the summaries already fetched above — no
   * new query reads this. `"OFF"` is deliberately not a problem: most of these modules are
   * optional and disabled by default, and painting that red would misreport the normal resting
   * state of a fresh install as broken. Every rule here mirrors a badge already rendered inside
   * that same card below, so the corner pill can never disagree with the numbers underneath it.
   */
  const moduleStatus: Record<string, ModuleHealthStatus> = {
    accounts: accountsRouting.hasRoutingError
      ? "DOWN" // a routed service has no healthy account to send through at all
      : accountsRouting.connectedCount < accountsRouting.accounts.length
        ? "ATTENTION"
        : "OPERATIONAL",
    automation: !automationOutbound.automationEnabled || automationOutbound.failed24h > 0 ? "ATTENTION" : "OPERATIONAL",
    escalations: escalation.openCaseCount > 0 ? "ATTENTION" : "OPERATIONAL",
    conversationLearning: !conversationLearning.conversationLearningEnabled
      ? "OFF"
      : conversationLearning.unknownPatternCount > 0
        ? "ATTENTION"
        : "OPERATIONAL",
    aiLearning: !aiLearning.aiEngineEnabled ? "OFF" : aiLearning.activeProviderCount === 0 ? "ATTENTION" : "OPERATIONAL",
    // No failure signal is tracked at this summary level — a broadcast job's own errors surface on
    // its own detail page, not here — so this card has nothing honest to flag as attention.
    bulkMessaging: "OPERATIONAL",
    notifications: notifications.failed24h > 0 ? "ATTENTION" : "OPERATIONAL",
    supportActivity: supportActivity.enabled ? "OPERATIONAL" : "OFF",
    teamsIntegration:
      teamsIntegration.status === "DISCONNECTED"
        ? "OFF"
        : teamsIntegration.status === "REAUTH_REQUIRED" || teamsIntegration.status === "ERROR"
          ? "ATTENTION"
          : "OPERATIONAL",
    systemLogs: systemLogs.errors24h > 0 || systemLogs.warnings24h > 0 ? "ATTENTION" : "OPERATIONAL",
  };
  const modulesNeedingAttention = Object.values(moduleStatus).filter(
    (status) => status === "ATTENTION" || status === "DOWN",
  ).length;
  const totalModules = Object.keys(moduleStatus).length;

  /**
   * The handful of things worth interrupting for, most severe first. This is deliberately a short,
   * concrete list rather than one line per module card above — the grid already shows every card's
   * own status, and repeating all ten here would bury the two or three that actually need a human.
   */
  const issues: Array<{ text: string; href: string; linkLabel: string }> = [];
  if (workerLiveness.workerOffline) {
    issues.push({
      text:
        workerLiveness.lastHeartbeatAt === null
          ? "The worker has never checked in — nothing on this dashboard can change until it starts."
          : `The worker has been silent for ${workerLiveness.silentForMinutes} minute(s) — reconnects, sends and every background job are stopped.`,
      href: "/accounts",
      linkLabel: "Check accounts",
    });
  }
  if (accountsRouting.hasRoutingError) {
    issues.push({
      text: "A routed WhatsApp service has no healthy connected account to send through.",
      href: "/accounts/routing",
      linkLabel: "Fix routing",
    });
  }
  if (disconnectedAccounts.length > 0) {
    issues.push({
      text: `${disconnectedAccounts.length} account(s) not connected: ${disconnectedAccounts.map((a) => a.label).join(", ")}.`,
      href: "/accounts",
      linkLabel: "Reconnect",
    });
  }
  if (!automationOutbound.automationEnabled) {
    issues.push({
      text: "Automation is paused — no rule or AI reply will be sent until it is turned back on.",
      href: "/automation-control",
      linkLabel: "Review",
    });
  }
  if (systemLogs.errors24h > 0) {
    issues.push({
      text: `${systemLogs.errors24h} error(s) logged in the last 24 hours.`,
      href: "/logs?level=ERROR",
      linkLabel: "View logs",
    });
  }

  // Same three-tier read as each module pill: DOWN beats ATTENTION beats a quiet OPERATIONAL.
  const systemStatus: ModuleHealthStatus =
    workerLiveness.workerOffline || accountsRouting.hasRoutingError
      ? "DOWN"
      : issues.length > 0
        ? "ATTENTION"
        : "OPERATIONAL";

  return (
    <div>
      <PageHeader
        title={
          <span className="inline-flex items-center gap-2.5">
            Overview
            <Badge color={SYSTEM_STATUS_BADGE[systemStatus]} dot pulse={systemStatus !== "OPERATIONAL"}>
              {SYSTEM_STATUS_LABEL[systemStatus]}
            </Badge>
          </span>
        }
        description={`Live snapshot of the automation system — ${totalModules - modulesNeedingAttention} of ${totalModules} modules operational.`}
        actions={
          <>
            {/* A real destination, never a mutating action — Overview stays entirely read-only,
                every control here only navigates to a page where the actual change is made. */}
            <ButtonLink href="/automation-control" variant="secondary">
              <Power className="size-3.5" aria-hidden />
              Automation Control
            </ButtonLink>
            <HelpButton moduleTitle="Overview">
            <HelpSection title="What this page is for">
              <p>
                The landing page after login — a glanceable, entirely read-only summary of every
                module. There are no controls here; every number and card links to a page elsewhere
                where you can act on it.
              </p>
            </HelpSection>
            <HelpSection title="Reading the stat tiles">
              <p>
                "Support required (24h)" and "Failed notifications (24h)" are rolling 24-hour counts,
                not live queue depths — a 0 doesn't mean the underlying queue is empty, just that
                nothing new arrived in the last day. "Outbound queue (pending)" and "Open escalation
                cases" are current snapshots, not history.
              </p>
            </HelpSection>
            <HelpSection title="Module cards">
              <p>
                Each card shows the 2-4 numbers that matter most for that module right now. "View
                module" jumps to the full page for details, filters, and actions.
              </p>
            </HelpSection>
            <HelpSection title="Metrics">
              <p>
                Four views of what the system is actually doing. "Incoming message volume" is daily
                totals for 14 days, with the last 7 compared against the 7 before them. "Automation
                decisions" is what the rule engine concluded per message in the last 24 hours — a
                growing "No rule matched" share is the sign your ruleset has fallen behind what
                customers are asking. "Message load by hour" is a rolling 24 hours, useful for
                deciding when to staff and when to schedule a broadcast. "Outbound delivery" and
                "Busiest groups" cover send health and where the week's load landed.
              </p>
              <p>
                Every figure is computed live per request from the raw tables — nothing here is
                pre-aggregated or cached, so a number that looks wrong is a real number.
                Days are Asia/Dhaka days, the same boundary the Support Activity reports use.
              </p>
            </HelpSection>
            <HelpSection title="Latest messages">
              <p>
                Just the last 10 messages across every account for a quick pulse-check — for
                anything beyond that, go to All Messages.
              </p>
            </HelpSection>
          </HelpButton>
          </>
        }
      />

      {issues.length > 0 ? (
        <div className="mb-7">
          <Alert
            tone={systemStatus === "DOWN" ? "danger" : "warning"}
            title={issues.length === 1 ? "1 thing needs attention" : `${issues.length} things need attention`}
          >
            <ul className="space-y-1.5">
              {issues.map((issue) => (
                <li key={issue.text} className="flex flex-wrap items-baseline gap-x-2">
                  <span>{issue.text}</span>
                  <Link href={issue.href} className="font-medium underline underline-offset-2">
                    {issue.linkLabel}
                  </Link>
                </li>
              ))}
            </ul>
          </Alert>
        </div>
      ) : null}

      <div className="stagger-children mb-7 grid grid-cols-2 gap-3.5 sm:grid-cols-4 xl:grid-cols-8">
        {/* Each href lands on the rows this number counted, already filtered. Where no page
            lists those rows, the tile stays inert — see the outbound queue below. */}
        <StatTile
          href="/accounts"
          label="Connected accounts"
          value={`${accountsRouting.connectedCount}/${accountsRouting.accounts.length}`}
          tone={
            accountsRouting.connectedCount === accountsRouting.accounts.length && accountsRouting.accounts.length > 0
              ? "success"
              : "warning"
          }
        />
        <StatTile
          href="/support-activity/team"
          label="Waiting for a reply"
          value={awaiting.length}
          tone={awaiting.length > 0 ? "warning" : "success"}
        />
        {/* `within=24h` rather than a date: the tile counts a rolling window, and a calendar-day
            filter would land on a different set than the number shown. */}
        <StatTile
          href="/messages?within=24h"
          label="Incoming messages (24h)"
          value={recentActivity.messagesLast24h}
        />
        <StatTile
          href="/messages?decision=SUPPORT_REQUIRED&within=24h"
          label="Support required (24h)"
          value={automationOutbound.supportRequiredLast24h}
          tone={automationOutbound.supportRequiredLast24h > 0 ? "warning" : "neutral"}
        />
        <StatTile href="/rules?status=ACTIVE" label="Active rules" value={automationOutbound.activeRuleCount} />
        {/* Deliberately not a link. This counts every unsettled outbound row — auto-replies,
            manual sends and broadcast rows alike — and no page lists that queue in full. The
            closest candidate, /messages?autoReplyStatus=PENDING, covers only the auto-reply
            subset, so it would show a smaller number under the same label and send somebody
            hunting for the difference. An outbound-queue page would make this linkable. */}
        <StatTile
          label="Outbound queue (pending)"
          value={automationOutbound.outboundPendingCount}
          tone={automationOutbound.outboundPendingCount > 0 ? "warning" : "neutral"}
        />
        <StatTile
          href="/notifications?status=FAILED"
          label="Failed notifications (24h)"
          value={notifications.failed24h}
          tone={notifications.failed24h > 0 ? "danger" : "neutral"}
        />
        {/* No query needed: Active Cases only ever lists open ones, so the page IS the filter. */}
        <StatTile
          href="/support-escalation"
          label="Open escalation cases"
          value={escalation.openCaseCount}
          tone={escalation.openCaseCount > 0 ? "warning" : "neutral"}
        />
        <StatTile
          href="/conversation-learning/unknown-patterns"
          label="Unresolved unknown patterns"
          value={conversationLearning.unknownPatternCount}
          tone={conversationLearning.unknownPatternCount > 0 ? "warning" : "neutral"}
        />
      </div>

      <section className="mb-7" aria-label="Metrics">
        <SectionHeader
          title="Metrics"
          description="Live aggregates computed per request — every figure links back to a page where you can act on it."
        />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <ChartCard
            className="lg:col-span-2"
            href="/messages?within=14d"
            title="Incoming message volume"
            description="Daily totals for the last 14 days, on Asia/Dhaka day boundaries."
            headline={
              <ChartHeadline
                value={formatCount(messageLoad.lastSeven)}
                delta={
                  messageLoad.weekOverWeekPercent === null
                    ? undefined
                    : `${messageLoad.weekOverWeekPercent >= 0 ? "+" : ""}${messageLoad.weekOverWeekPercent}% vs prior 7 days`
                }
                deltaTone={
                  messageLoad.weekOverWeekPercent === null || messageLoad.weekOverWeekPercent === 0
                    ? "neutral"
                    : messageLoad.weekOverWeekPercent > 0
                      ? "up"
                      : "down"
                }
                caption="last 7 days"
              />
            }
          >
            <AreaChart data={messageLoad.daily} ariaLabel="Incoming messages per day, last 14 days" />
          </ChartCard>

          <ChartCard
            href="/messages?within=24h"
            title="Automation decisions"
            description="What the rule engine decided in the last 24 hours."
          >
            <DonutChart
              slices={decisionMix.slices}
              total={decisionMix.total}
              centerLabel="decisions"
              ariaLabel="Automation decisions by outcome, last 24 hours"
            />
          </ChartCard>

          <ChartCard
            className="lg:col-span-2"
            href="/messages?within=24h"
            title="Message load by hour"
            description="Rolling 24 hours — the darker column is the busiest hour."
            headline={
              messageLoad.peakHourLabel ? (
                <ChartHeadline
                  value={formatCount(messageLoad.peakHourValue)}
                  caption={`peak at ${messageLoad.peakHourLabel}`}
                />
              ) : undefined
            }
          >
            <ColumnChart data={messageLoad.hourly} ariaLabel="Incoming messages per hour, last 24 hours" />
          </ChartCard>

          <ChartCard
            className="lg:col-span-2"
            href="/ai-learning/activity"
            title="AI answers and handovers"
            description="Every message the rule engine missed in an AI-eligible group, by day. A handover is the safety rule working, not a failure."
            headline={
              aiOutcomes.answeredSharePercent === null ? undefined : (
                <ChartHeadline
                  value={`${aiOutcomes.answeredSharePercent}%`}
                  caption={`answered without a person \u00b7 ${formatCount(aiOutcomes.totalHandedOver)} handed over`}
                />
              )
            }
          >
            {/* Two stacked charts rather than one two-series plot: the kit has no grouped-series
                chart, and inventing one for this would be a bigger change than the question
                deserves. Reading them as a pair still answers it — the shapes diverge when the
                ratio moves. */}
            <div className="space-y-3">
              <div>
                <p className="mb-1 text-xs text-[color:var(--color-muted-foreground)]">
                  Answered by AI
                </p>
                <ColumnChart
                  data={aiOutcomes.replied}
                  ariaLabel="Messages answered by AI per day, last 14 days"
                  height={64}
                  labelEvery={3}
                />
              </div>
              <div>
                <p className="mb-1 text-xs text-[color:var(--color-muted-foreground)]">
                  Handed to a person
                </p>
                <ColumnChart
                  data={aiOutcomes.handedOver}
                  ariaLabel="Messages handed to a person per day, last 14 days"
                  height={64}
                  labelEvery={3}
                />
              </div>
            </div>
          </ChartCard>

          <ChartCard
            href="/support-activity"
            title="Support delivered"
            description="Who answered customers over the last 7 days."
            headline={
              actorMix.aiOnlyGroups > 0 ? (
                <ChartHeadline
                  value={formatCount(actorMix.aiOnlyGroups)}
                  caption="groups no colleague touched"
                />
              ) : undefined
            }
          >
            <DonutChart
              slices={actorMix.slices}
              total={actorMix.total}
              centerLabel="activities"
              ariaLabel="Support activities by actor, last 7 days"
            />
          </ChartCard>

          <ChartCard
            className="lg:col-span-2"
            href="/support-activity/team"
            title="How long customers wait"
            description="Median minutes to a first reply, by day. Median rather than average — one conversation answered next morning would drag an average past every honest reading of the day."
            headline={
              responseTimes.latestMedianMinutes === null ? undefined : (
                <ChartHeadline
                  value={`${responseTimes.latestMedianMinutes}m`}
                  caption="most recent day with replies"
                />
              )
            }
          >
            <AreaChart
              data={responseTimes.daily}
              ariaLabel="Median minutes to first reply per day, last 14 days"
              unitLabel="min"
            />
          </ChartCard>

          <div className="flex flex-col gap-4">
            <ChartCard
              href="/support-activity/team"
              title="Busiest executives"
              description="Support messages per person over the last 7 days."
            >
              <BarList
                items={executiveLoad.people}
                emptyMessage="No support activity recorded in the last 7 days."
              />
            </ChartCard>

            <ChartCard
              title="Outbound delivery"
              description="Every message the send queue handled in the last 24 hours."
              headline={
                deliveryOutcomes.successRate === null ? undefined : (
                  <ChartHeadline value={`${deliveryOutcomes.successRate}%`} caption="sent" />
                )
              }
            >
              <StackedBar
                segments={deliveryOutcomes.slices}
                total={deliveryOutcomes.total}
                ariaLabel="Outbound message outcomes, last 24 hours"
              />
            </ChartCard>

            <ChartCard
              title="Busiest groups"
              description="Incoming messages per group over the last 7 days."
            >
              <BarList
                items={busiestGroups.groups.map((group) => ({
                  id: group.id,
                  label: group.name,
                  value: group.value,
                }))}
                emptyMessage="No group messages in the last 7 days."
              />
            </ChartCard>
          </div>
        </div>
      </section>

      <div className="stagger-children mb-7 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
        <DashboardModuleCard
          title="Accounts & Routing"
          icon={Smartphone}
          href="/accounts"
          status={moduleStatus.accounts}
          secondaryLink={accountsRouting.hasRoutingError ? { href: "/accounts/routing", label: "Fix routing" } : undefined}
        >
          <ModuleCardRow label="Connected">
            <Badge
              color={
                accountsRouting.connectedCount === accountsRouting.accounts.length && accountsRouting.accounts.length > 0
                  ? "green"
                  : "yellow"
              }
              dot
            >
              {accountsRouting.connectedCount}/{accountsRouting.accounts.length}
            </Badge>
          </ModuleCardRow>
          <ModuleCardRow label="Services routed">
            <Badge color={accountsRouting.hasRoutingError ? "red" : "green"} dot>
              {accountsRouting.healthyRouteCount}/{accountsRouting.totalRoutes}
            </Badge>
          </ModuleCardRow>
          {accountsRouting.pendingWorkerCommands > 0 ? (
            <ModuleCardRow label="Waiting on worker">{accountsRouting.pendingWorkerCommands} command(s)</ModuleCardRow>
          ) : null}
        </DashboardModuleCard>

        <DashboardModuleCard title="Automation Rules & Outbound" icon={ListChecks} href="/rules" status={moduleStatus.automation}>
          <ModuleCardRow label="Automation">
            <Badge color={automationOutbound.automationEnabled ? "green" : "red"} dot>
              {automationOutbound.automationEnabled ? "ENABLED" : "PAUSED"}
            </Badge>
          </ModuleCardRow>
          <ModuleCardRow label="Active rules">{automationOutbound.activeRuleCount}</ModuleCardRow>
          <ModuleCardRow label="Outbound (24h)">
            {automationOutbound.sent24h} sent
            {automationOutbound.failed24h > 0 ? `, ${automationOutbound.failed24h} failed` : ""}
            {automationOutbound.rateLimited24h > 0 ? `, ${automationOutbound.rateLimited24h} rate-limited` : ""}
          </ModuleCardRow>
        </DashboardModuleCard>

        <DashboardModuleCard title="Escalations" icon={ShieldAlert} href="/support-escalation" status={moduleStatus.escalations}>
          <ModuleCardRow label="Open cases">
            <Badge color={escalation.openCaseCount > 0 ? "yellow" : "green"} dot>
              {escalation.openCaseCount}
            </Badge>
          </ModuleCardRow>
          <ModuleCardRow label="Escalated">
            <Badge color={escalation.escalatedCount > 0 ? "red" : "gray"} dot>
              {escalation.escalatedCount}
            </Badge>
          </ModuleCardRow>
          <ModuleCardRow label="Oldest waiting">
            {escalation.oldestWaitingSince
              ? `${formatAgeShort(nowMs - escalation.oldestWaitingSince.getTime())} (${escalation.oldestWaitingGroupName})`
              : "—"}
          </ModuleCardRow>
        </DashboardModuleCard>

        <DashboardModuleCard title="Conversation Learning" icon={Waypoints} href="/conversation-learning" status={moduleStatus.conversationLearning}>
          <ModuleCardRow label="Status">
            <Badge color={conversationLearning.conversationLearningEnabled ? "green" : "gray"} dot>
              {conversationLearning.conversationLearningEnabled ? "ENABLED" : "DISABLED"}
            </Badge>
          </ModuleCardRow>
          <ModuleCardRow label="Patterns surfaced">{conversationLearning.surfacedCandidateCount}</ModuleCardRow>
          <ModuleCardRow label="Unknown patterns">
            <Badge color={conversationLearning.unknownPatternCount > 0 ? "yellow" : "gray"} dot>
              {conversationLearning.unknownPatternCount}
            </Badge>
          </ModuleCardRow>
          <ModuleCardRow label="Proposals pending">{conversationLearning.pendingProposalCount}</ModuleCardRow>
        </DashboardModuleCard>

        <DashboardModuleCard title="AI Learning" icon={Sparkles} href="/ai-learning" status={moduleStatus.aiLearning}>
          <ModuleCardRow label="Status">
            <Badge color={aiLearning.aiEngineEnabled ? "green" : "gray"} dot>
              {aiLearning.aiEngineEnabled ? "ENABLED" : "DISABLED"}
            </Badge>
          </ModuleCardRow>
          <ModuleCardRow label="Knowledge items">{aiLearning.totalKnowledge}</ModuleCardRow>
          <ModuleCardRow label="Active providers">
            <Badge color={aiLearning.activeProviderCount > 0 ? "green" : "yellow"} dot>
              {aiLearning.activeProviderCount}
            </Badge>
          </ModuleCardRow>
        </DashboardModuleCard>

        <DashboardModuleCard
          title="Bulk Messaging"
          icon={Send}
          href="/group-message-sender"
          status={moduleStatus.bulkMessaging}
          secondaryLink={{ href: "/group-member-adder", label: "Add to groups" }}
        >
          <ModuleCardRow label="Broadcast jobs">{bulkMessaging.broadcastRunning} running/queued</ModuleCardRow>
          <ModuleCardRow label="Add-to-group jobs">{bulkMessaging.addRunning} running/queued</ModuleCardRow>
        </DashboardModuleCard>

        <DashboardModuleCard title="Notifications" icon={Bell} href="/notifications" status={moduleStatus.notifications}>
          <ModuleCardRow label="Sent (24h)">{notifications.sent24h}</ModuleCardRow>
          <ModuleCardRow label="Failed (24h)">
            <Badge color={notifications.failed24h > 0 ? "red" : "gray"} dot>
              {notifications.failed24h}
            </Badge>
          </ModuleCardRow>
          <ModuleCardRow label="Pending/retrying (24h)">{notifications.pendingRetrying24h}</ModuleCardRow>
        </DashboardModuleCard>

        <DashboardModuleCard title="Support Activity" icon={Activity} href="/support-activity" status={moduleStatus.supportActivity}>
          <ModuleCardRow label="Status">
            <Badge color={supportActivity.enabled ? "green" : "gray"} dot>
              {supportActivity.enabled ? "ENABLED" : "DISABLED"}
            </Badge>
          </ModuleCardRow>
          <ModuleCardRow label="Today's activities">{supportActivity.todayActivities}</ModuleCardRow>
          <ModuleCardRow label="Today's supported groups">{supportActivity.todaySupportedGroups}</ModuleCardRow>
        </DashboardModuleCard>

        <DashboardModuleCard
          title="Teams Integration"
          icon={Link2}
          href="/integrations/teams"
          status={moduleStatus.teamsIntegration}
          secondaryLink={{ href: "/issues", label: "View issues" }}
        >
          <ModuleCardRow label="Connection">
            <Badge
              color={
                teamsIntegration.status === "CONNECTED" || teamsIntegration.status === "SYNCING"
                  ? "green"
                  : teamsIntegration.status === "REAUTH_REQUIRED"
                    ? "yellow"
                    : teamsIntegration.status === "ERROR"
                      ? "red"
                      : "gray"
              }
              dot
            >
              {teamsIntegration.status}
            </Badge>
          </ModuleCardRow>
          <ModuleCardRow label="Open issues">
            <Badge color={teamsIntegration.openIssueCount > 0 ? "yellow" : "gray"} dot>
              {teamsIntegration.openIssueCount}
            </Badge>
          </ModuleCardRow>
          <ModuleCardRow label="Resolved today">{teamsIntegration.resolvedTodayCount}</ModuleCardRow>
        </DashboardModuleCard>

        <DashboardModuleCard title="System Logs" icon={ConsoleIcon} href="/logs" status={moduleStatus.systemLogs}>
          <ModuleCardRow label="Errors (24h)">
            <Badge color={systemLogs.errors24h > 0 ? "red" : "gray"} dot>
              {systemLogs.errors24h}
            </Badge>
          </ModuleCardRow>
          <ModuleCardRow label="Warnings (24h)">
            <Badge color={systemLogs.warnings24h > 0 ? "yellow" : "gray"} dot>
              {systemLogs.warnings24h}
            </Badge>
          </ModuleCardRow>
        </DashboardModuleCard>
      </div>

      <Card>
        <SectionHeader
          title="Live Traffic & Automation Stream"
          description="The last 10 messages across every account, and what the automation layer actually did with each one — volume over time is charted in Metrics above."
        />
        {recentActivity.recentMessages.length === 0 ? (
          <EmptyState>No messages yet.</EmptyState>
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th>Time</Th>
                  <Th>Account · Group</Th>
                  <Th>Sender</Th>
                  <Th>Message</Th>
                  <Th>Automation Trace</Th>
                  <Th>Confidence</Th>
                  <Th> </Th>
                </tr>
              </thead>
              <tbody>
                {recentActivity.recentMessages.map((m) => (
                  <tr key={m.id}>
                    <Td className="font-[family-name:var(--font-mono)] text-xs whitespace-nowrap">
                      {formatDateTime(m.timestampWa)}
                    </Td>
                    <Td className="text-xs">
                      <div className="font-medium text-[color:var(--color-foreground)]">{m.accountLabel}</div>
                      {m.groupName ? (
                        <div className="text-[color:var(--color-muted-foreground)]">{m.groupName}</div>
                      ) : null}
                    </Td>
                    <Td className="font-[family-name:var(--font-mono)] text-xs">{m.senderName ?? m.senderPhone}</Td>
                    <Td className="max-w-md truncate">{m.body}</Td>
                    <Td>
                      <Badge color={m.trace.tone} dot>
                        {m.trace.label}
                      </Badge>
                    </Td>
                    <Td className="tabular-nums text-xs">
                      {m.trace.confidencePercent === null ? "—" : `${m.trace.confidencePercent}%`}
                    </Td>
                    <Td>
                      <Link
                        href={`/messages/${m.id}`}
                        className="text-xs font-medium text-[color:var(--color-foreground)] underline-offset-2 hover:underline"
                      >
                        View
                      </Link>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <div className="mt-4 flex items-center justify-between border-t border-[var(--color-border)] pt-3.5 text-xs text-[color:var(--color-muted-foreground)]">
              <span>
                Showing the latest {recentActivity.recentMessages.length} of {formatCount(recentActivity.messagesLast24h)} incoming
                messages today.
              </span>
              <Link href="/messages" className="font-medium text-[color:var(--color-foreground)] underline-offset-2 hover:underline">
                View full message history
              </Link>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
