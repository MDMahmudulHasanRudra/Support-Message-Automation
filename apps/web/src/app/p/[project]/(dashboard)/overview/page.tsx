/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */
import {
  Activity,
  BarChart3,
  Bell,
  Bot,
  CalendarClock,
  Clock,
  Headphones,
  HeartPulse,
  HelpCircle,
  History,
  Inbox,
  LifeBuoy,
  ListChecks,
  MessageCircle,
  MessagesSquare,
  Power,
  Send,
  SendHorizontal,
  ShieldAlert,
  ShoppingBag,
  Smartphone,
  Timer,
  TrendingUp,
  UserPlus,
  Users,
  Zap,
} from "lucide-react";
import { formatHoursMinutes, pathAllowedByFeatures } from "@support-automation/shared";
import { activeDisabledFeatures } from "@/server/projectFeatures";
import { countMyAttention } from "@/server/followUps";
import { getGrantedPermissionKeys } from "@/server/permissions";
import { cookies } from "next/headers";
import { activeProjectId } from "@/server/projectContext";
import { ActionList, ActivityFeed, ChartEmpty, ClosableGuide, GettingStarted, HealthList, humanDuration, ModuleSummary, QuickActions, SectionTitle, setupGuideCookie, type ActionItem, type ActivityEntry, type HealthRow, type QuickAction } from "@/components/dashboard";
import { CHANNEL_PRESENTATION } from "../conversations/ChannelMark";
import { navPermissionFor } from "../navigation";
import { requireSession } from "@/server/auth";
import { getPageAccess } from "@/server/permissions";
import { canOpenPath, dashboardPartsOf, describePath, type DashboardPartId } from "../projectSections";
import { YourPages } from "./YourPages";
import { isProjectAccessLevel, isProjectFeatureKey, PERMISSIONS, PROJECT_ACCESS_LEVEL_LABELS, projectFeatureDefinition } from "@support-automation/shared";
import {
  Alert,
  ButtonLink,
  HeroKpi,
  HelpButton,
  HelpSection,
  PageHeader,
  StatTile,
} from "@/components/ui";
import type { ModuleHealthStatus } from "@/components/ui/DashboardModuleCard";
import { getGroupsAwaitingReply } from "@/server/supportActivityReports";
import { softCached } from "@/server/softCache";
import { getClientOverview, getCommerceOverview, getDeskOverview, getGettingStarted, getSetupChecklist } from "@/server/moduleOverview";
import {
  AreaChart,
  BarList,
  ChartCard,
  ChartHeadline,
  ColumnChart,
  DonutChart,
  StackedBar,
  formatCount,
  Heatmap,
  TrafficChart,
} from "@/components/charts";
import {
  getAccountsRoutingSummary,
  getAiLearningSummary,
  getAutomationOutboundSummary,
  getBulkMessagingSummary,
  getConversationLearningSummary,
  getEscalationSummary,
  getNotificationsSummary,
  getCollectionHealthSummary,
  getRecentMessageActivity,
  getSupportActivityDashboardSummary,
  getSystemLogsSummary,
  getWorkerLivenessSummary,
} from "@/server/actions/dashboardSummary";
import {
  getAiOutcomeSeries,
  getBusiestGroups,
  getChannelMix,
  getDecisionMix,
  getDeliveryOutcomes,
  getExecutiveLoad,
  getOutgoingDaily,
  getWeekHeat,
  getMessageLoadSeries,
  getResponseTimeSeries,
  getSupportActorMix,
} from "@/server/actions/dashboardMetrics";

/** Time of day in Dhaka, which every "today" in this product uses. */
function greetingFor(nowMs: number): string {
  const hour = new Date(nowMs + 6 * 3_600_000).getUTCHours();
  return hour < 5 ? "Good night" : hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
}

function formatAgeShort(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ denied?: string; unavailable?: string; level?: string; page?: string; guide?: string }>;
}) {
  const session = await requireSession();
  // Set by requirePermission when a page or an action refused this user. Only a known key is
  // named, so a hand-edited URL cannot put arbitrary text into the banner.
  const deniedParam = (await searchParams).denied ?? "";
  // Set when the role allows the page but this project's access level does not (MAIN_ADMIN_WORKSPACE.md §4).
  const deniedLevel = isProjectAccessLevel((await searchParams).level) ? (await searchParams).level : null;
  // A page of a feature this project is not entitled to sends people here (MULTI_PROJECT_PLAN.md §9).
  const unavailableParam = (await searchParams).unavailable;
  const unavailable = isProjectFeatureKey(unavailableParam) ? projectFeatureDefinition(unavailableParam) : null;
  const denied = PERMISSIONS.find((p) => p.key === deniedParam) ?? null;
  // Set when a member's project role does not open a page (PROJECT_ROLES.md). Only a known page is
  // named, so a hand-edited URL cannot put arbitrary text into the banner.
  const pageParam = (await searchParams).page ?? "";
  const blockedPage = pageParam ? (describePath(pageParam) ?? "That page") : null;

  // A project role that selects pages also chooses which parts of this page it shows; null = all of
  // them, as for every global role, Lead and Main Admin. A link to a page the role does not open is
  // left out rather than offered and refused.
  const pageAccess = await getPageAccess(session);
  const notices = <OverviewNotices denied={denied} deniedLevel={deniedLevel} unavailable={unavailable} blockedPage={blockedPage} />;
  if (pageAccess && dashboardPartsOf(pageAccess).size === 0) return <YourPages access={pageAccess} notices={notices} />;
  const parts = pageAccess ? dashboardPartsOf(pageAccess) : null;
  const show = (part: DashboardPartId) => parts === null || parts.has(part);
  const link = (href: string) => (pageAccess === null || canOpenPath(href, pageAccess) ? href : undefined);

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
    collectionHealth,
    commerce,
    setupChecklist,
    clients,
    disabledFeatures,
    gettingStarted,
    grantedKeys,
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
    softCached("overview:message-load", () => getMessageLoadSeries(nowMs)),
    softCached("overview:decision-mix", () => getDecisionMix(nowMs)),
    softCached("overview:delivery", () => getDeliveryOutcomes(nowMs)),
    softCached("overview:busiest-groups", () => getBusiestGroups(nowMs)),
    softCached("overview:ai-outcomes", () => getAiOutcomeSeries(nowMs)),
    softCached("overview:response-times", () => getResponseTimeSeries(nowMs)),
    softCached("overview:actor-mix", () => getSupportActorMix(nowMs)),
    softCached("overview:executive-load", () => getExecutiveLoad(nowMs)),
    getGroupsAwaitingReply(new Date(nowMs)),
    getWorkerLivenessSummary(nowMs),
    getCollectionHealthSummary(nowMs),
    // Module-aware parts (PROJECT_MODULES.md §Dashboard): null / empty whenever the modules are off.
    getCommerceOverview(new Date(nowMs)),
    getSetupChecklist(),
    getClientOverview(session),
    activeDisabledFeatures(),
    getGettingStarted(),
    getGrantedPermissionKeys(session),
  ]);
  const channelMix = disabledFeatures.has("OMNICHANNEL")
    ? null
    : await getChannelMix(nowMs, Object.fromEntries(Object.entries(CHANNEL_PRESENTATION).map(([key, c]) => [key, { label: c.short, color: c.tint }])));
  // A quick action or button only for a page this viewer can open, with its module on.
  const granted = new Set(grantedKeys);
  const canUse = (href: string) => {
    const key = navPermissionFor(href);
    return (key === null || granted.has(key)) && pathAllowedByFeatures(href, disabledFeatures) && Boolean(link(href));
  };
  const followUps = disabledFeatures.has("FOLLOW_UPS") ? null : await countMyAttention(session, new Date(nowMs));
  const [outgoingDaily, weekHeat, desk] = await Promise.all([
    softCached("overview:outgoing-daily", () => getOutgoingDaily(nowMs)),
    softCached("overview:week-heat", () => getWeekHeat(nowMs, !disabledFeatures.has("OMNICHANNEL"))),
    getDeskOverview(session, new Date(nowMs)),
  ]);
  const traffic = messageLoad.daily.map((d, i) => ({ label: d.label, incoming: d.value, outgoing: outgoingDaily[i] ?? 0 }));


  const disconnectedAccounts = accountsRouting.accounts.filter((a) => a.status !== "CONNECTED");

  /**
   * One status per module card, derived entirely from the summaries already fetched above — no
   * new query reads this. `"OFF"` is deliberately not a problem: most of these modules are
   * optional and disabled by default, and painting that red would misreport the normal resting
   * state of a fresh install as broken. Every rule here mirrors a badge already rendered inside
   * that same card below, so the corner pill can never disagree with the numbers underneath it.
   */
  const moduleStatus: Record<string, ModuleHealthStatus> = {
    accounts:
      accountsRouting.hasRoutingError || collectionHealth.stuckAccounts.length > 0
        ? "DOWN" // no healthy account to send through, or a number that cannot receive at all
        : accountsRouting.connectedCount < accountsRouting.accounts.length ||
            collectionHealth.silentAccounts.length > 0
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
          : `The worker has been silent for ${humanDuration(workerLiveness.silentForMinutes ?? 0)}. Reconnects, sends and every background job are stopped.`,
      href: "/accounts",
      linkLabel: "Check accounts",
    });
  }
  if (workerLiveness.stalledLoop) {
    // The reading the heartbeat cannot give. It proves one `setInterval` fires and shares nothing
    // with the other twenty, so a wedged outbound queue or command processor leaves the worker
    // looking perfectly healthy — replies queued and never sent, dashboard buttons that write a
    // row nothing reads.
    issues.push({
      text: `The worker's "${workerLiveness.stalledLoop.name}" background job has not run for ${workerLiveness.stalledLoop.overdueMinutes} minute(s), though the worker itself is responding.`,
      href: "/logs?level=ERROR",
      linkLabel: "View logs",
    });
  }
  // Directly under the worker-offline line, and above everything else, because this is the only
  // entry that reports customers not reaching you AT ALL. On 18 Sep 2026 a number sat green and
  // collecting nothing for 3 h 15 m with nothing on this page to suggest it.
  for (const account of collectionHealth.stuckAccounts) {
    issues.push({
      text:
        account.status === "RECONNECTING"
          ? `"${account.label}" is stuck mid-reconnect — it is not receiving customer messages and will not clear this on its own.`
          : `"${account.label}" needs to be linked again from the phone — it is not receiving customer messages.`,
      href: "/accounts",
      linkLabel: "Open accounts",
    });
  }
  for (const account of collectionHealth.silentAccounts) {
    // Worded as an observation, never a verdict. A quiet Friday looks exactly like this from
    // stored rows alone, and only the worker can ask WhatsApp which of the two it is.
    issues.push({
      text: `"${account.label}" is connected but has stored no message for ${formatAgeShort(account.quietForMinutes * 60_000)} — worth confirming customers are still getting through.`,
      href: "/accounts",
      linkLabel: "Open accounts",
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
  // A stuck session ranks with the other two: it means customer messages are not arriving, which
  // is the most consequential thing this page can report and the one it used to miss entirely.
  const systemStatus: ModuleHealthStatus =
    workerLiveness.workerOffline || accountsRouting.hasRoutingError || collectionHealth.stuckAccounts.length > 0
      ? "DOWN"
      : issues.length > 0
        ? "ATTENTION"
        : "OPERATIONAL";

  // ── The large figures ───────────────────────────────────────────────────────────────────────
  const oldest = awaiting[0] ?? null;
  const showAi = aiLearning.aiEngineEnabled && aiOutcomes.answeredSharePercent !== null;
  const weekDelta =
    messageLoad.weekOverWeekPercent === null
      ? undefined
      : { text: `${messageLoad.weekOverWeekPercent >= 0 ? "+" : ""}${messageLoad.weekOverWeekPercent}%`, direction: (messageLoad.weekOverWeekPercent > 0 ? "up" : messageLoad.weekOverWeekPercent < 0 ? "down" : "flat") as "up" | "down" | "flat" };

  // ── Needs you ───────────────────────────────────────────────────────────────────────────────
  const needs: ActionItem[] = [];
  if (show("dashboard:alerts")) {
    issues.forEach((issue, i) => needs.push({ key: `issue-${i}`, kind: systemStatus === "DOWN" && i === 0 ? "down" : "warning", title: issue.text, href: link(issue.href), action: issue.linkLabel }));
    if (escalation.openCaseCount > 0) {
      needs.push({
        key: "escalations",
        kind: "warning",
        title: escalation.openCaseCount === 1 ? "1 open escalation" : `${formatCount(escalation.openCaseCount)} open escalations`,
        detail: escalation.oldestWaitingSince ? `Oldest waiting ${formatHoursMinutes((nowMs - escalation.oldestWaitingSince.getTime()) / 1000)}, ${escalation.oldestWaitingGroupName}` : undefined,
        href: link("/support-escalation"),
        action: "Open",
      });
    }
    if (followUps && followUps.overdue + followUps.dueToday > 0) {
      needs.push({
        key: "follow-ups",
        kind: followUps.overdue > 0 ? "warning" : "waiting",
        title: followUps.overdue > 0 ? `${followUps.overdue} of your follow-ups ${followUps.overdue === 1 ? "is" : "are"} overdue` : `${followUps.dueToday} follow-up${followUps.dueToday === 1 ? "" : "s"} due today`,
        href: link("/follow-ups"),
        action: "Open",
      });
    }
    for (const row of awaiting.slice(0, 3)) {
      needs.push({
        key: `wait-${row.groupId}`,
        kind: "waiting",
        title: `${row.customerName} in ${row.groupName}`,
        detail: `Waiting ${formatHoursMinutes(row.waitingSeconds)}${row.lastMessage ? `: ${row.lastMessage}` : ""}`,
        href: link("/chat") ? `/chat/${row.groupId}` : undefined,
        action: "Reply",
      });
    }
    for (const item of setupChecklist) {
      needs.push({ key: `setup-${item.module}-${item.text}`, kind: "setup", title: item.text, detail: item.module, href: link(item.href), action: item.linkLabel });
    }
  }
  const NEEDS_SHOWN = 5;
  const statusLine =
    systemStatus === "DOWN"
      ? (issues[0]?.text ?? "Something needs action now.")
      : needs.length > 0
        ? needs.length === 1
          ? "1 thing needs you today."
          : `${needs.length} things need you today.`
        : `All clear. ${totalModules - modulesNeedingAttention} of ${totalModules} modules healthy.`;

  // ── Health ──────────────────────────────────────────────────────────────────────────────────
  const healthRows: HealthRow[] = [
    { key: "worker", title: "Worker", status: workerLiveness.workerOffline ? "DOWN" : workerLiveness.stalledLoop ? "ATTENTION" : "OPERATIONAL", statusLabel: workerLiveness.workerOffline ? "Offline" : workerLiveness.stalledLoop ? "Check" : "Online", href: link("/logs") },
    { key: "accounts", title: "WhatsApp numbers", status: moduleStatus.accounts, statusLabel: `${accountsRouting.connectedCount}/${accountsRouting.accounts.length} online`, href: accountsRouting.hasRoutingError ? (link("/accounts/routing") ?? link("/accounts")) : link("/accounts") },
    { key: "automation", title: "Automation", status: moduleStatus.automation, statusLabel: automationOutbound.automationEnabled ? (automationOutbound.failed24h > 0 ? `${automationOutbound.failed24h} failed` : "On") : "Paused", href: link("/rules") },
    { key: "escalations", title: "Escalations", status: moduleStatus.escalations, statusLabel: `${escalation.openCaseCount} open`, href: link("/support-escalation") },
    { key: "ai", title: "AI knowledge", status: moduleStatus.aiLearning, statusLabel: aiLearning.aiEngineEnabled ? `${formatCount(aiLearning.totalKnowledge)} items` : "Off", href: link("/ai-learning") },
    { key: "learning", title: "Conversation learning", status: moduleStatus.conversationLearning, statusLabel: conversationLearning.conversationLearningEnabled ? `${conversationLearning.unknownPatternCount} unknown` : "Off", href: link("/conversation-learning") },
    { key: "bulk", title: "Bulk messaging", status: moduleStatus.bulkMessaging, statusLabel: `${bulkMessaging.broadcastRunning + bulkMessaging.addRunning} running`, href: link("/group-message-sender") },
    { key: "notifications", title: "Notifications", status: moduleStatus.notifications, statusLabel: notifications.failed24h > 0 ? `${notifications.failed24h} failed` : `${notifications.sent24h} sent`, href: link("/notifications") },
    { key: "activity", title: "Support tracking", status: moduleStatus.supportActivity, statusLabel: supportActivity.enabled ? "On" : "Off", href: link("/support-activity") },
    { key: "logs", title: "System logs", status: moduleStatus.systemLogs, statusLabel: systemLogs.errors24h + systemLogs.warnings24h > 0 ? `${systemLogs.errors24h} errors` : "Clean", href: link("/logs") },
  ];

  // ── Quick actions: only what this viewer can open, with its module on ──────────────────────────
  const inboxHref = disabledFeatures.has("OMNICHANNEL") ? "/chat" : "/conversations/all";
  const quickActions: QuickAction[] = (
    [
      { label: "Open inbox", href: inboxHref, icon: Inbox },
      { label: "Add a client", href: "/clients/new", icon: UserPlus },
      { label: "New order", href: "/commerce/orders/new", icon: ShoppingBag },
      { label: "Follow-ups", href: "/follow-ups", icon: CalendarClock },
      { label: "Team report", href: "/team-report", icon: BarChart3 },
      { label: "Automation rules", href: "/rules", icon: ListChecks },
    ] satisfies QuickAction[]
  )
    .filter((a) => canUse(a.href))
    .slice(0, 5);

  // The setup guide: closed by this person for this project stays closed, until they ask for it from Quick actions.
  const guideCookie = setupGuideCookie(await activeProjectId(), session.userId);
  const guideClosed = (await cookies()).get(guideCookie)?.value === "1" && (await searchParams).guide !== "1";
  const guideUnfinished = gettingStarted.some((step) => !step.done);
  if (guideClosed && guideUnfinished) quickActions.push({ label: "Setup guide", href: "/overview?guide=1", icon: ListChecks });

  // ── Recent activity ─────────────────────────────────────────────────────────────────────────
  const activity: ActivityEntry[] = recentActivity.recentMessages.slice(0, 6).map((m) => ({
    key: m.id,
    icon: MessageCircle,
    tint: m.trace.tone === "red" ? "danger" : m.trace.tone === "yellow" ? "warning" : m.trace.tone === "green" ? "success" : m.trace.tone === "blue" ? "accent" : "neutral",
    title: `${m.senderName ?? m.senderPhone}${m.groupName ? ` in ${m.groupName}` : ""}`,
    detail: `${m.trace.label}: ${m.body}`,
    time: formatAgeShort(nowMs - new Date(m.timestampWa).getTime()),
    href: link("/messages") ? `/messages/${m.id}` : undefined,
  }));

  return (
    <div>
      <PageHeader
        title={`${greetingFor(nowMs)}, ${session.username}`}
        description={statusLine}
        actions={
          <>
            {/* A real destination, never a mutating action: Overview stays read-only. */}
            {canUse("/automation-control") ? (
              <ButtonLink href="/automation-control" variant="secondary">
                <Power className="size-3.5" aria-hidden />
                Automation control
              </ButtonLink>
            ) : null}
            {canUse(inboxHref) ? (
              <ButtonLink href={inboxHref} variant="primary">
                <Inbox className="size-4" aria-hidden />
                Open inbox
              </ButtonLink>
            ) : null}
            <HelpButton moduleTitle="Overview">
              <HelpSection title="What this page is for">
                <p>
                  The landing page after login: how the day stands, what needs a person, and whether the business and the
                  system are healthy. It is read-only; every figure links to the page where you can act on it.
                </p>
              </HelpSection>
              <HelpSection title="Reading the figures">
                <p>
                  "Last 24 hours" figures are rolling counts, not live queue depths: a 0 means nothing new arrived in the last
                  day. "Outbound queue" and "Open escalations" are current snapshots.
                </p>
              </HelpSection>
              <HelpSection title="Action required">
                <p>Connection problems first, then escalations, your follow-ups, the customers waiting longest and any module still to set up.</p>
              </HelpSection>
              <HelpSection title="Sections">
                <p>
                  Clients and Commerce appear only when those modules are on for this project. Every figure is computed live from
                  the raw tables, nothing is pre-aggregated, and days are Asia/Dhaka days.
                </p>
              </HelpSection>
            </HelpButton>
          </>
        }
      />

      {notices}

      {show("dashboard:alerts") && guideUnfinished && !guideClosed ? (
        <div className="mb-4">
          <ClosableGuide cookieName={guideCookie}>
            <GettingStarted steps={gettingStarted} />
          </ClosableGuide>
        </div>
      ) : null}

      {show("dashboard:tiles") ? (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <HeroKpi
              tone="tide"
              icon={MessagesSquare}
              label="Messages (24h)"
              value={formatCount(recentActivity.messagesLast24h)}
              href={link("/messages?within=24h")}
              delta={weekDelta}
              sub={weekDelta ? "this week vs last" : undefined}
              spark={messageLoad.hourly.map((b) => b.value)}
              sparkLabel="Incoming messages per hour, last 24 hours"
            />
            <HeroKpi
              tone="navy"
              icon={Timer}
              label="Median first reply"
              value={responseTimes.latestMedianMinutes === null ? "No data" : `${responseTimes.latestMedianMinutes}m`}
              href={link("/support-activity/team")}
              sub={responseTimes.latestMedianMinutes === null ? "Measured once the team replies" : "Most recent day with replies"}
              spark={responseTimes.measured > 1 ? responseTimes.daily.map((b) => b.value) : undefined}
              sparkLabel="Median minutes to first reply per day, last 14 days"
            />
            {showAi ? (
              <HeroKpi
                tone="sea"
                icon={Bot}
                label="Answered by AI"
                value={`${aiOutcomes.answeredSharePercent}%`}
                href={link("/ai-learning/activity")}
                sub={`${formatCount(aiOutcomes.totalHandedOver)} handed to a person, 14 days`}
                spark={aiOutcomes.replied.map((b) => b.value)}
                sparkLabel="Messages answered by AI per day, last 14 days"
              />
            ) : (
              <HeroKpi
                tone="sea"
                icon={SendHorizontal}
                label="Replies delivered"
                value={deliveryOutcomes.successRate === null ? "No data" : `${deliveryOutcomes.successRate}%`}
                sub={deliveryOutcomes.total === 0 ? "Nothing sent in the last 24 hours" : `${formatCount(deliveryOutcomes.total)} handled, last 24 hours`}
              />
            )}
            <HeroKpi
              tone={awaiting.length > 0 ? "amber" : "tide"}
              icon={Clock}
              label="Waiting for a reply"
              value={formatCount(awaiting.length)}
              href={link("/support-activity/team")}
              sub={oldest ? `Longest ${formatHoursMinutes(oldest.waitingSeconds)}, ${oldest.groupName}` : "Every monitored group is answered"}
            />
          </div>

          <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4 min-[1650px]:grid-cols-8">
            {/* Each href lands on the rows this number counted, already filtered. */}
            <StatTile
              href={link("/accounts")}
              icon={Smartphone}
              label="Connected numbers"
              value={`${accountsRouting.connectedCount}/${accountsRouting.accounts.length}`}
              tone={accountsRouting.connectedCount === accountsRouting.accounts.length && accountsRouting.accounts.length > 0 ? "success" : "warning"}
            />
            <StatTile href={link("/messages?decision=SUPPORT_REQUIRED&within=24h")} icon={Headphones} label="Support required" value={automationOutbound.supportRequiredLast24h} tone={automationOutbound.supportRequiredLast24h > 0 ? "warning" : "neutral"} />
            <StatTile href={link("/support-escalation")} icon={ShieldAlert} label="Open escalations" value={escalation.openCaseCount} tone={escalation.openCaseCount > 0 ? "warning" : "neutral"} />
            {/* Deliberately not a link: this counts every unsettled outbound row and no page lists that queue in full. */}
            <StatTile icon={Send} label="Outbound queue" value={automationOutbound.outboundPendingCount} tone={automationOutbound.outboundPendingCount > 0 ? "warning" : "neutral"} />
            <StatTile href={link("/rules?status=ACTIVE")} icon={Zap} label="Active rules" value={automationOutbound.activeRuleCount} tone="accent" />
            <StatTile href={link("/conversation-learning/unknown-patterns")} icon={HelpCircle} label="Unknown patterns" value={conversationLearning.unknownPatternCount} tone={conversationLearning.unknownPatternCount > 0 ? "warning" : "neutral"} />
            <StatTile href={link("/notifications?status=FAILED")} icon={Bell} label="Failed alerts" value={notifications.failed24h} tone={notifications.failed24h > 0 ? "danger" : "neutral"} />
            <StatTile href={link("/support-activity")} icon={Activity} label="Support today" value={supportActivity.todayActivities} />
          </div>
        </>
      ) : null}

      <SectionTitle title="Conversations and health" hint="How busy it is, whether everything is working, and what needs a person." />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-12">
        {show("dashboard:metrics") ? (
          <ChartCard
            className="lg:col-span-2 xl:col-span-5"
            icon={TrendingUp}
            href={link("/messages?within=14d")}
            title="Messages in and out"
            description="WhatsApp messages per day, last 14 days."
            headline={
              <ChartHeadline
                value={formatCount(messageLoad.lastSeven)}
                delta={messageLoad.weekOverWeekPercent === null ? undefined : `${messageLoad.weekOverWeekPercent >= 0 ? "+" : ""}${messageLoad.weekOverWeekPercent}% vs prior 7 days`}
                deltaTone={messageLoad.weekOverWeekPercent === null || messageLoad.weekOverWeekPercent === 0 ? "neutral" : messageLoad.weekOverWeekPercent > 0 ? "up" : "down"}
                caption="received, last 7 days"
              />
            }
          >
            {messageLoad.windowTotal === 0 ? (
              <ChartEmpty text="Nothing has arrived in the last 14 days. Messages start counting as soon as a connected number receives one." href={link("/accounts")} action="Check WhatsApp numbers" />
            ) : (
              <TrafficChart data={traffic} ariaLabel="WhatsApp messages received and sent per day, last 14 days" height={168} />
            )}
          </ChartCard>
        ) : null}

        {show("dashboard:metrics") ? (
          channelMix ? (
            <ChartCard className="xl:col-span-4" icon={MessagesSquare} title="Messages by channel" description="Customer messages, last 7 days.">
              {channelMix.total === 0 ? <ChartEmpty text="No customer messages on any channel in the last 7 days." href={link("/settings/channels")} action="Connect a channel" /> : <DonutChart slices={channelMix.slices} total={channelMix.total} centerLabel="messages" ariaLabel="Customer messages by channel, last 7 days" />}
            </ChartCard>
          ) : (
            <ChartCard className="xl:col-span-4" icon={Zap} href={link("/messages?within=24h")} title="Automation decisions" description="What the rule engine decided, 24 hours.">
              {decisionMix.total === 0 ? <ChartEmpty text="Decisions appear when messages arrive." href={link("/rules")} action="Review rules" /> : <DonutChart slices={decisionMix.slices} total={decisionMix.total} centerLabel="decisions" ariaLabel="Automation decisions by outcome, last 24 hours" />}
            </ChartCard>
          )
        ) : null}

        {show("dashboard:modules") ? (
          <div className="xl:col-span-3 [&>*]:h-full">
            <HealthList
              title="System health"
              icon={HeartPulse}
              verdict={{ label: systemStatus === "OPERATIONAL" ? "Healthy" : systemStatus === "DOWN" ? "Action" : "Check", state: systemStatus }}
              rows={healthRows}
            />
          </div>
        ) : null}

        {show("dashboard:alerts") ? (
          <div className="lg:col-span-2 xl:col-span-5 [&>*]:h-full">
            <ActionList items={needs.slice(0, NEEDS_SHOWN)} hiddenCount={Math.max(0, needs.length - NEEDS_SHOWN)} />
          </div>
        ) : null}

        {show("dashboard:stream") ? (
          <div className="xl:col-span-4 [&>*]:h-full">
            <ActivityFeed icon={History} entries={activity} action={link("/messages") ? { href: "/messages", label: "View all" } : undefined} emptyText="No messages yet. They appear here as soon as a connected number receives one." />
          </div>
        ) : null}

        <div className="xl:col-span-3 [&>*]:h-full">
          <QuickActions icon={Zap} actions={quickActions} />
        </div>
      </div>

      {show("dashboard:tiles") && (clients || commerce || desk) ? (
        <>
        <SectionTitle title="Your business" hint="Customers, open work and sales kept in this project." />
        <div className="space-y-4">
          {desk ? (
            <ModuleSummary
              title="Support desk"
              icon={LifeBuoy}
              action={desk.tickets && link("/tickets") ? { href: "/tickets", label: "View tickets" } : desk.followUps && link("/follow-ups") ? { href: "/follow-ups", label: "View follow-ups" } : undefined}
              figures={[
                ...(desk.tickets
                  ? [
                      { key: "t-open", label: "Open tickets", value: formatCount(desk.tickets.open), href: link("/tickets"), hint: desk.tickets.unassigned > 0 ? `${formatCount(desk.tickets.unassigned)} with no owner` : "Every one has an owner" },
                      { key: "t-overdue", label: "Tickets past due", value: formatCount(desk.tickets.overdue), tone: desk.tickets.overdue > 0 ? ("danger" as const) : undefined, href: link("/tickets") },
                    ]
                  : []),
                ...(desk.followUps
                  ? [
                      { key: "f-today", label: "Follow-ups due today", value: formatCount(desk.followUps.dueToday), href: link("/follow-ups"), hint: `${formatCount(desk.followUps.open)} open in all` },
                      { key: "f-overdue", label: "Follow-ups overdue", value: formatCount(desk.followUps.overdue), tone: desk.followUps.overdue > 0 ? ("warning" as const) : undefined, href: link("/follow-ups") },
                    ]
                  : []),
                ...(desk.contacts ? [{ key: "contacts", label: "Contacts", value: formatCount(desk.contacts.total), href: link("/contacts"), hint: `${formatCount(desk.contacts.thisWeek)} added this week` }] : []),
                ...(desk.payments
                  ? [{ key: "pay", label: "Payment links waiting", value: formatCount(desk.payments.awaiting), tone: desk.payments.awaiting > 0 ? ("warning" as const) : undefined, href: link("/payments"), hint: `${formatCount(desk.payments.paidThisWeek)} paid this week` }]
                  : []),
              ]}
            />
          ) : null}
          {clients && link("/clients") ? (
            clients.total === 0 ? (
              <ChartEmpty text="No clients yet. Add them one by one or import a spreadsheet, and renewals and dues will show here." href="/clients" action="Open Clients" />
            ) : (
              <ModuleSummary
                title="Clients"
                icon={Users}
                action={{ href: "/clients", label: "View clients" }}
                figures={[
                  { key: "all", label: "All clients", value: formatCount(clients.total), hint: `${formatCount(clients.active)} with a running term` },
                  { key: "renew", label: "Renewals coming up", value: formatCount(clients.expiring), tone: clients.expiring > 0 ? "warning" : undefined, hint: "Inside the renewal window" },
                  { key: "expired", label: "Expired terms", value: formatCount(clients.expired), tone: clients.expired > 0 ? "danger" : undefined, hint: "Not renewed" },
                  ...(clients.unpaidDues !== null ? [{ key: "dues", label: "Open dues", value: formatCount(clients.unpaidDues), tone: clients.unpaidDues > 0 ? ("warning" as const) : undefined, hint: "Unpaid or part-paid" }] : []),
                ]}
              />
            )
          ) : null}
          {commerce ? (
            <ModuleSummary
              title="Commerce"
              icon={ShoppingBag}
              action={link("/commerce/orders") ? { href: "/commerce/orders", label: "View orders" } : undefined}
              figures={[
                ...(commerce.orders
                  ? [
                      { key: "today", label: "Orders today", value: commerce.orders.today, href: link("/commerce/orders") },
                      { key: "drafts", label: "Drafts to confirm", value: commerce.orders.toConfirm, tone: commerce.orders.toConfirm > 0 ? ("warning" as const) : undefined, href: link("/commerce/orders?status=DRAFT") },
                      { key: "unpaid", label: "Not fully paid", value: commerce.orders.unpaid, tone: commerce.orders.unpaid > 0 ? ("warning" as const) : undefined },
                    ]
                  : []),
                ...(commerce.catalog
                  ? [
                      { key: "active", label: "Active products", value: commerce.catalog.active, href: link("/commerce/products") },
                      { key: "out", label: "Out of stock", value: commerce.catalog.outOfStock, tone: commerce.catalog.outOfStock > 0 ? ("danger" as const) : undefined, href: link("/commerce/products") },
                      { key: "low", label: "Low stock (5 or fewer)", value: commerce.catalog.lowStock, tone: commerce.catalog.lowStock > 0 ? ("warning" as const) : undefined, href: link("/commerce/products") },
                    ]
                  : []),
                ...(commerce.shipments
                  ? [
                      { key: "transit", label: "Parcels on the way", value: commerce.shipments.inTransit, href: link("/commerce/shipments") },
                      { key: "check", label: "Bookings to check", value: commerce.shipments.toCheck, tone: commerce.shipments.toCheck > 0 ? ("danger" as const) : undefined, href: link("/commerce/shipments?status=UNKNOWN") },
                    ]
                  : []),
                ...(commerce.leads
                  ? [
                      { key: "leads", label: "Open leads", value: commerce.leads.open, href: link("/sales") },
                      { key: "overdue", label: "Lead follow-ups overdue", value: commerce.leads.overdue, tone: commerce.leads.overdue > 0 ? ("warning" as const) : undefined, href: link("/sales") },
                    ]
                  : []),
              ]}
            />
          ) : null}
        </div>
        </>
      ) : null}

      {show("dashboard:metrics") ? (
        <section aria-label="Performance">
          <SectionTitle title="Performance" hint="Live figures, computed on every visit. Days are Asia/Dhaka days." />
          {/* Fixed pairs, one per row: a wide chart beside the narrow card answering the same kind of question. */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <ChartCard
              className="lg:col-span-2"
              icon={BarChart3}
              href={link("/messages?within=24h")}
              title="Message load by hour"
              description="Rolling 24 hours. The darker column is the busiest hour."
              headline={messageLoad.peakHourLabel ? <ChartHeadline value={formatCount(messageLoad.peakHourValue)} caption={`peak at ${messageLoad.peakHourLabel}`} /> : undefined}
            >
              <ColumnChart data={messageLoad.hourly} ariaLabel="Incoming messages per hour, last 24 hours" />
            </ChartCard>
            {channelMix ? (
              <ChartCard icon={Zap} href={link("/messages?within=24h")} title="Automation decisions" description="What the rule engine decided, 24 hours.">
                {decisionMix.total === 0 ? <ChartEmpty text="Decisions appear when messages arrive." href={link("/rules")} action="Review rules" /> : <DonutChart slices={decisionMix.slices} total={decisionMix.total} centerLabel="decisions" ariaLabel="Automation decisions by outcome, last 24 hours" />}
              </ChartCard>
            ) : (
              <ChartCard icon={Send} title="Outbound delivery" description="Everything the send queue handled, 24 hours." headline={deliveryOutcomes.successRate === null ? undefined : <ChartHeadline value={`${deliveryOutcomes.successRate}%`} caption="sent" />}>
                {deliveryOutcomes.total === 0 ? <ChartEmpty text="Nothing was sent in the last 24 hours." /> : <StackedBar segments={deliveryOutcomes.slices} total={deliveryOutcomes.total} ariaLabel="Outbound message outcomes, last 24 hours" />}
              </ChartCard>
            )}

            <ChartCard
              className="lg:col-span-2"
              icon={Timer}
              href={link("/support-activity/team")}
              title="How long customers wait"
              description="Median minutes to a first reply, by day. Median, because one conversation answered next morning would distort an average."
              headline={responseTimes.latestMedianMinutes === null ? undefined : <ChartHeadline value={`${responseTimes.latestMedianMinutes}m`} caption="most recent day with replies" />}
            >
              {responseTimes.measured === 0 ? <ChartEmpty text="Measured once customers have been answered in monitored groups." /> : <AreaChart data={responseTimes.daily} ariaLabel="Median minutes to first reply per day, last 14 days" unitLabel="min" />}
            </ChartCard>
            {channelMix ? (
              <ChartCard icon={Send} title="Outbound delivery" description="Everything the send queue handled, 24 hours." headline={deliveryOutcomes.successRate === null ? undefined : <ChartHeadline value={`${deliveryOutcomes.successRate}%`} caption="sent" />}>
                {deliveryOutcomes.total === 0 ? <ChartEmpty text="Nothing was sent in the last 24 hours." /> : <StackedBar segments={deliveryOutcomes.slices} total={deliveryOutcomes.total} ariaLabel="Outbound message outcomes, last 24 hours" />}
              </ChartCard>
            ) : (
              <ChartCard icon={Users} href={link("/support-activity/team")} title="Busiest team members" description="Support messages per person, 7 days.">
                <BarList items={executiveLoad.people} emptyMessage="No support activity in the last 7 days." />
              </ChartCard>
            )}

            <ChartCard
              className="lg:col-span-2"
              icon={Bot}
              href={link("/ai-learning/activity")}
              title="AI answers and handovers"
              description="Messages no rule matched in AI-eligible groups. A handover is the safety rule working, not a failure."
              headline={aiOutcomes.answeredSharePercent === null ? undefined : <ChartHeadline value={`${aiOutcomes.answeredSharePercent}%`} caption={`answered · ${formatCount(aiOutcomes.totalHandedOver)} handed over`} />}
            >
              {aiOutcomes.answeredSharePercent === null ? (
                <ChartEmpty text={aiLearning.aiEngineEnabled ? "No message has reached AI in the last 14 days." : "AI is off for this project. Switch it on to answer what no rule covers."} href={link("/ai-learning")} action="Open AI settings" />
              ) : (
                <div className="space-y-3">
                  <div>
                    <p className="mb-1 text-xs text-[color:var(--color-muted-foreground)]">Answered by AI</p>
                    <ColumnChart data={aiOutcomes.replied} ariaLabel="Messages answered by AI per day, last 14 days" height={64} labelEvery={3} />
                  </div>
                  <div>
                    <p className="mb-1 text-xs text-[color:var(--color-muted-foreground)]">Handed to a person</p>
                    <ColumnChart data={aiOutcomes.handedOver} ariaLabel="Messages handed to a person per day, last 14 days" height={64} labelEvery={3} />
                  </div>
                </div>
              )}
            </ChartCard>
            <ChartCard
              icon={Headphones}
              href={link("/support-activity")}
              title="Support delivered"
              description="Who answered customers, 7 days."
              headline={actorMix.aiOnlyGroups > 0 ? <ChartHeadline value={formatCount(actorMix.aiOnlyGroups)} caption="groups no colleague touched" /> : undefined}
            >
              {actorMix.total === 0 ? <ChartEmpty text="Nothing was answered in the last 7 days." /> : <DonutChart slices={actorMix.slices} total={actorMix.total} centerLabel="activities" ariaLabel="Support activities by actor, last 7 days" />}
            </ChartCard>

            <ChartCard className={channelMix ? "lg:col-span-2" : "lg:col-span-3"} icon={MessagesSquare} title="Busiest groups" description="Incoming messages per group, 7 days.">
              <BarList items={busiestGroups.groups.map((group) => ({ id: group.id, label: group.name, value: group.value }))} emptyMessage="No group messages in the last 7 days." />
            </ChartCard>
            {channelMix ? (
              <ChartCard icon={Users} href={link("/support-activity/team")} title="Busiest team members" description="Support messages per person, 7 days.">
                <BarList items={executiveLoad.people} emptyMessage="No support activity in the last 7 days." />
              </ChartCard>
            ) : null}

            <ChartCard
              className="lg:col-span-3"
              icon={CalendarClock}
              title="When customers write"
              description="Customer messages by weekday and hour (Dhaka time), last 4 weeks. Darker means busier: plan shifts around it."
              headline={weekHeat.busiestLabel ? <ChartHeadline value={weekHeat.busiestLabel} caption="busiest hour" /> : undefined}
            >
              {weekHeat.total === 0 ? <ChartEmpty text="No customer messages in the last 4 weeks yet." /> : <Heatmap grid={weekHeat.grid} unitLabel="messages" ariaLabel="Customer messages by weekday and hour, last 4 weeks" />}
            </ChartCard>
          </div>
        </section>
      ) : null}
    </div>
  );
}


/** The banners explaining why somebody was sent here. Shared by the Overview and "Your pages". */
function OverviewNotices({
  denied,
  deniedLevel,
  unavailable,
  blockedPage,
}: {
  denied: (typeof PERMISSIONS)[number] | null;
  deniedLevel: string | null | undefined;
  unavailable: { label: string } | null;
  blockedPage: string | null;
}) {
  return (
    <>
    {denied ? (
      <div className="mb-5">
        {deniedLevel ? (
          <Alert tone="warning" title="Your access to this project does not allow that">
            You were sent here because your access to this project is{" "}
            {PROJECT_ACCESS_LEVEL_LABELS[deniedLevel as keyof typeof PROJECT_ACCESS_LEVEL_LABELS]}, which does not include{" "}
            {denied.label.charAt(0).toLowerCase() + denied.label.slice(1)}. Your role does include it — a Main Admin can
            change your access level for this project.
          </Alert>
        ) : (
          <Alert tone="warning" title="Your role does not allow that">
            You were sent here because {denied.label.charAt(0).toLowerCase() + denied.label.slice(1)} is not part
            of your Permission Module. Ask an administrator to add it if you need it.
          </Alert>
        )}
      </div>
    ) : null}

    {unavailable ? (
      <div className="mb-5">
        <Alert tone="info" title={`${unavailable.label} is not enabled for this project`}>
          That page belongs to {unavailable.label}, which this project is not set up to use. A Main Admin can turn it on
          in the Main Admin Portal.
        </Alert>
      </div>
    ) : null}

      {blockedPage ? (
        <div className="mb-5">
          <Alert tone="warning" title="Your project role does not include that page">
            {blockedPage} is not one of the pages your role opens in this project — or your role can only look at it, not
            change it. The project&apos;s Lead chooses which pages each role opens; ask them if you need it.
          </Alert>
        </div>
      ) : null}
    </>
  );
}
