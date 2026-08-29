/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */
import { Activity, Bell, Link2, ListChecks, Send, ShieldAlert, Smartphone, Sparkles, Terminal as ConsoleIcon, Waypoints } from "lucide-react";
import { requireSession } from "@/server/auth";
import { formatDateTime } from "@/lib/date";
import {
  Alert,
  Badge,
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
} from "@/server/actions/dashboardSummary";
import {
  getBusiestGroups,
  getDecisionMix,
  getDeliveryOutcomes,
  getMessageLoadSeries,
} from "@/server/actions/dashboardMetrics";

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
  ]);

  const disconnectedAccounts = accountsRouting.accounts.filter((a) => a.status !== "CONNECTED");

  return (
    <div>
      <PageHeader
        title="Overview"
        description="Live snapshot of the automation system."
        actions={
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
        }
      />

      {disconnectedAccounts.length > 0 ? (
        <div className="mb-7">
          <Alert tone="warning" title={`${disconnectedAccounts.length} account(s) not connected`}>
            {disconnectedAccounts.map((a) => a.label).join(", ")} — check WhatsApp Accounts for details.
          </Alert>
        </div>
      ) : null}

      <div className="stagger-children mb-7 grid grid-cols-2 gap-3.5 sm:grid-cols-4">
        <StatTile
          label="Connected accounts"
          value={`${accountsRouting.connectedCount}/${accountsRouting.accounts.length}`}
          tone={
            accountsRouting.connectedCount === accountsRouting.accounts.length && accountsRouting.accounts.length > 0
              ? "success"
              : "warning"
          }
        />
        <StatTile label="Incoming messages (24h)" value={recentActivity.messagesLast24h} />
        <StatTile
          label="Support required (24h)"
          value={automationOutbound.supportRequiredLast24h}
          tone={automationOutbound.supportRequiredLast24h > 0 ? "warning" : "neutral"}
        />
        <StatTile label="Active rules" value={automationOutbound.activeRuleCount} />
        <StatTile
          label="Outbound queue (pending)"
          value={automationOutbound.outboundPendingCount}
          tone={automationOutbound.outboundPendingCount > 0 ? "warning" : "neutral"}
        />
        <StatTile
          label="Failed notifications (24h)"
          value={notifications.failed24h}
          tone={notifications.failed24h > 0 ? "danger" : "neutral"}
        />
        <StatTile
          label="Open escalation cases"
          value={escalation.openCaseCount}
          tone={escalation.openCaseCount > 0 ? "warning" : "neutral"}
        />
        <StatTile
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

          <div className="flex flex-col gap-4">
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

        <DashboardModuleCard title="Automation Rules & Outbound" icon={ListChecks} href="/rules">
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

        <DashboardModuleCard title="Escalations" icon={ShieldAlert} href="/support-escalation">
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

        <DashboardModuleCard title="Conversation Learning" icon={Waypoints} href="/conversation-learning">
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

        <DashboardModuleCard title="AI Learning" icon={Sparkles} href="/ai-learning">
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
          secondaryLink={{ href: "/group-member-adder", label: "Add to groups" }}
        >
          <ModuleCardRow label="Broadcast jobs">{bulkMessaging.broadcastRunning} running/queued</ModuleCardRow>
          <ModuleCardRow label="Add-to-group jobs">{bulkMessaging.addRunning} running/queued</ModuleCardRow>
        </DashboardModuleCard>

        <DashboardModuleCard title="Notifications" icon={Bell} href="/notifications">
          <ModuleCardRow label="Sent (24h)">{notifications.sent24h}</ModuleCardRow>
          <ModuleCardRow label="Failed (24h)">
            <Badge color={notifications.failed24h > 0 ? "red" : "gray"} dot>
              {notifications.failed24h}
            </Badge>
          </ModuleCardRow>
          <ModuleCardRow label="Pending/retrying (24h)">{notifications.pendingRetrying24h}</ModuleCardRow>
        </DashboardModuleCard>

        <DashboardModuleCard title="Support Activity" icon={Activity} href="/support-activity">
          <ModuleCardRow label="Status">
            <Badge color={supportActivity.enabled ? "green" : "gray"} dot>
              {supportActivity.enabled ? "ENABLED" : "DISABLED"}
            </Badge>
          </ModuleCardRow>
          <ModuleCardRow label="Today's activities">{supportActivity.todayActivities}</ModuleCardRow>
          <ModuleCardRow label="Today's supported groups">{supportActivity.todaySupportedGroups}</ModuleCardRow>
        </DashboardModuleCard>

        <DashboardModuleCard title="Teams Integration" icon={Link2} href="/integrations/teams" secondaryLink={{ href: "/issues", label: "View issues" }}>
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

        <DashboardModuleCard title="System Logs" icon={ConsoleIcon} href="/logs">
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
          title="Latest messages"
          description="The last 10 messages across every account — volume over time is charted in Metrics above."
        />
        {recentActivity.recentMessages.length === 0 ? (
          <EmptyState>No messages yet.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Time</Th>
                <Th>Sender</Th>
                <Th>Direction</Th>
                <Th>Body</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {recentActivity.recentMessages.map((m) => (
                <tr key={m.id}>
                  <Td className="font-[family-name:var(--font-mono)] text-xs whitespace-nowrap">
                    {formatDateTime(m.timestampWa)}
                  </Td>
                  <Td className="font-[family-name:var(--font-mono)] text-xs">{m.senderName ?? m.senderPhone}</Td>
                  <Td>{m.direction}</Td>
                  <Td className="max-w-md truncate">{m.body}</Td>
                  <Td>
                    <Badge color={m.processingStatus === "IGNORED" ? "gray" : "blue"}>{m.processingStatus}</Badge>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
