import { prisma, resolveWhatsAppAccount, isResolutionError } from "@support-automation/db";
import type { EscalationStatus, PatternCandidateStatus, WhatsAppServiceKey } from "@prisma/client";
import { getDhakaDayRange } from "@/lib/supportActivityPeriod";
import { getEveryActivityCount, getUniqueGroupCount } from "@/server/supportActivityReports";
import { decisionLabel } from "@/server/actions/dashboardMetrics";

// Server-component-only read helpers for the /overview dashboard — no "use server" directive,
// these are never invoked from a client event handler.

function hoursAgo(hours: number, nowMs: number): Date {
  return new Date(nowMs - hours * 60 * 60 * 1000);
}

function sumCounts<T extends string>(groups: Array<{ status?: T; level?: T; _count: { status?: number; level?: number } }>): number {
  return groups.reduce((total, g) => total + (g._count.status ?? g._count.level ?? 0), 0);
}

const ROUTED_SERVICES: WhatsAppServiceKey[] = ["NOTIFY_WHATSAPP", "PRIORITY_SUPPORT", "CONVERSATION_LEARNING"];

export async function getAccountsRoutingSummary() {
  const [accounts, pendingWorkerCommands, ...resolutions] = await Promise.all([
    prisma.whatsAppAccount.findMany({ select: { id: true, label: true, status: true } }),
    prisma.workerCommand.count({ where: { status: { in: ["PENDING", "PROCESSING"] } } }),
    ...ROUTED_SERVICES.map((key) => resolveWhatsAppAccount(key)),
  ]);

  const connectedCount = accounts.filter((a) => a.status === "CONNECTED").length;
  const healthyRouteCount = resolutions.filter((r) => !isResolutionError(r)).length;
  const hasRoutingError = healthyRouteCount < resolutions.length;

  return {
    accounts,
    connectedCount,
    pendingWorkerCommands,
    healthyRouteCount,
    totalRoutes: ROUTED_SERVICES.length,
    hasRoutingError,
  };
}

export async function getAutomationOutboundSummary(nowMs: number) {
  const since24h = hoursAgo(24, nowMs);

  const [automationSettings, activeRuleCount, decisionGroups, outboundPendingCount, outbound24hGroups] =
    await Promise.all([
      prisma.automationSettings.findUnique({ where: { id: "global" } }),
      prisma.automationRule.count({ where: { status: "ACTIVE" } }),
      prisma.automationExecution.groupBy({
        by: ["decision"],
        where: { createdAt: { gte: since24h } },
        _count: { decision: true },
      }),
      prisma.outboundMessage.count({ where: { status: { in: ["PENDING", "PROCESSING"] } } }),
      prisma.outboundMessage.groupBy({
        by: ["status"],
        where: { createdAt: { gte: since24h } },
        _count: { status: true },
      }),
    ]);

  const supportRequiredLast24h =
    decisionGroups.find((g) => g.decision === "SUPPORT_REQUIRED")?._count.decision ?? 0;

  const countByStatus = (status: string) =>
    outbound24hGroups.find((g) => g.status === status)?._count.status ?? 0;

  return {
    automationEnabled: Boolean(automationSettings?.automationEnabled),
    activeRuleCount,
    supportRequiredLast24h,
    outboundPendingCount,
    sent24h: countByStatus("SENT"),
    failed24h: countByStatus("FAILED"),
    rateLimited24h: countByStatus("RATE_LIMITED"),
  };
}

const ACTIVE_ESCALATION_STATUSES: EscalationStatus[] = [
  "NEW",
  "MONITORING",
  "WAITING_FOR_HUMAN",
  "SECOND_ALERT",
  "MEMBER_ESCALATED",
  "ADMIN_ESCALATED",
  "FOLLOW_UP",
];
const ESCALATED_STATUSES: EscalationStatus[] = [
  "SECOND_ALERT",
  "MEMBER_ESCALATED",
  "ADMIN_ESCALATED",
  "FOLLOW_UP",
];

export async function getEscalationSummary() {
  const [statusGroups, oldestCase] = await Promise.all([
    prisma.supportEscalationCase.groupBy({
      by: ["status"],
      where: { status: { in: ACTIVE_ESCALATION_STATUSES } },
      _count: { status: true },
    }),
    prisma.supportEscalationCase.findFirst({
      where: { status: { in: ACTIVE_ESCALATION_STATUSES } },
      orderBy: { lastCustomerMessageAt: "asc" },
      select: { lastCustomerMessageAt: true, group: { select: { name: true } } },
    }),
  ]);

  const openCaseCount = sumCounts(statusGroups);
  const escalatedCount = sumCounts(statusGroups.filter((g) => ESCALATED_STATUSES.includes(g.status)));

  return {
    openCaseCount,
    escalatedCount,
    oldestWaitingSince: oldestCase?.lastCustomerMessageAt ?? null,
    oldestWaitingGroupName: oldestCase?.group.name ?? null,
  };
}

const RESOLVED_PATTERN_STATUSES: PatternCandidateStatus[] = ["APPROVED", "REJECTED", "MERGED", "EXPIRED"];

export async function getConversationLearningSummary() {
  const learningSettings = await prisma.learningSettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" },
  });

  const [surfacedCandidateCount, unknownPatternCount, pendingProposalCount] = await Promise.all([
    prisma.patternCandidate.count({
      where: {
        occurrenceCount: { gte: learningSettings.minOccurrenceForCandidate },
        distinctGroupCount: { gte: learningSettings.minDistinctGroupsForCandidate },
        distinctClientCount: { gte: learningSettings.minDistinctClientsForCandidate },
      },
    }),
    prisma.patternCandidate.count({
      where: {
        unhandledCount: { gte: learningSettings.minOccurrenceForCandidate },
        distinctGroupCount: { gte: learningSettings.minDistinctGroupsForCandidate },
        distinctClientCount: { gte: learningSettings.minDistinctClientsForCandidate },
        status: { notIn: RESOLVED_PATTERN_STATUSES },
      },
    }),
    prisma.ruleProposal.count({ where: { status: "PENDING_REVIEW" } }),
  ]);

  return {
    conversationLearningEnabled: learningSettings.conversationLearningEnabled,
    surfacedCandidateCount,
    unknownPatternCount,
    pendingProposalCount,
  };
}

export async function getAiLearningSummary() {
  const [aiSettings, totalKnowledge, activeProviderCount] = await Promise.all([
    prisma.aiSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } }),
    prisma.aiKnowledgeItem.count(),
    prisma.aiProvider.count({ where: { status: "ACTIVE" } }),
  ]);

  return {
    aiEngineEnabled: aiSettings.aiEngineEnabled,
    totalKnowledge,
    activeProviderCount,
  };
}

export async function getBulkMessagingSummary() {
  const [broadcastGroups, addGroups] = await Promise.all([
    prisma.groupBroadcastJob.groupBy({ by: ["status"], _count: { status: true } }),
    prisma.groupParticipantAddJob.groupBy({ by: ["status"], _count: { status: true } }),
  ]);

  const runningCount = (groups: typeof broadcastGroups) =>
    sumCounts(groups.filter((g) => g.status === "QUEUED" || g.status === "RUNNING"));

  return {
    broadcastRunning: runningCount(broadcastGroups),
    addRunning: runningCount(addGroups),
  };
}

export async function getNotificationsSummary(nowMs: number) {
  const since24h = hoursAgo(24, nowMs);
  const groups = await prisma.notification.groupBy({
    by: ["status"],
    where: { createdAt: { gte: since24h } },
    _count: { status: true },
  });

  const countByStatus = (status: string) => groups.find((g) => g.status === status)?._count.status ?? 0;

  return {
    sent24h: countByStatus("SENT"),
    failed24h: countByStatus("FAILED"),
    pendingRetrying24h: countByStatus("PENDING") + countByStatus("RETRYING"),
  };
}

export async function getSystemLogsSummary(nowMs: number) {
  const since24h = hoursAgo(24, nowMs);
  const groups = await prisma.systemLog.groupBy({
    by: ["level"],
    where: { createdAt: { gte: since24h } },
    _count: { level: true },
  });

  const countByLevel = (level: string) => groups.find((g) => g.level === level)?._count.level ?? 0;

  return {
    errors24h: countByLevel("ERROR"),
    warnings24h: countByLevel("WARN"),
  };
}

export async function getSupportActivityDashboardSummary(nowMs: number) {
  const settings = await prisma.supportActivitySettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" },
  });
  const today = getDhakaDayRange(new Date(nowMs));
  const [todayActivities, todaySupportedGroups] = await Promise.all([
    getEveryActivityCount(today),
    getUniqueGroupCount(today),
  ]);

  return { enabled: settings.enabled, todayActivities, todaySupportedGroups };
}

export async function getTeamsIntegrationSummary(nowMs: number) {
  // Dhaka, like every other "today" on this dashboard — setHours() would have used the
  // container's own timezone, so the same page could report two different days at once.
  const todayStart = getDhakaDayRange(new Date(nowMs)).start;
  const [account, openIssueCount, resolvedTodayCount] = await Promise.all([
    prisma.teamsAccount.findUnique({ where: { id: "global" } }),
    prisma.supportIssue.count({ where: { status: { notIn: ["RESOLVED", "CLOSED"] } } }),
    prisma.supportIssue.count({ where: { status: "RESOLVED", resolvedAt: { gte: todayStart } } }),
  ]);

  return {
    status: account?.status ?? "DISCONNECTED",
    openIssueCount,
    resolvedTodayCount,
  };
}

/**
 * Whether the worker process is alive at all.
 *
 * Every figure on the dashboard is a row some background loop wrote. With the worker down they all
 * simply stop moving, and a quiet afternoon looks exactly the same as a dead process — so the
 * landing page has to say which it is rather than leaving a reader to infer it from flat charts.
 *
 * Deliberately duplicates the small staleness computation the WhatsApp Accounts page already does
 * inline rather than refactoring that page to share it: this is five lines of arithmetic over one
 * column, and rewiring a live, heavily-used page to export it would be a change with real
 * regression surface for no behavioural gain. The 60-second threshold matches it because the
 * worker's heartbeat is a 15-second loop — four missed beats is dead, not slow.
 */
const WORKER_STALE_AFTER_MS = 60_000;

export async function getWorkerLivenessSummary(nowMs: number) {
  const newest = await prisma.whatsAppAccount.aggregate({ _max: { lastHeartbeatAt: true } });
  const lastHeartbeatAt = newest._max.lastHeartbeatAt ?? null;
  const lastHeartbeatMs = lastHeartbeatAt?.getTime() ?? null;

  return {
    lastHeartbeatAt,
    /** True when it has never checked in at all, or has been silent past the threshold. */
    workerOffline: lastHeartbeatMs === null || nowMs - lastHeartbeatMs > WORKER_STALE_AFTER_MS,
    silentForMinutes: lastHeartbeatMs === null ? null : Math.floor((nowMs - lastHeartbeatMs) / 60_000),
  };
}

/** What the automation layer actually did with one message, in the words the charts already use. */
export interface MessageTrace {
  label: string;
  tone: "green" | "yellow" | "red" | "gray" | "blue";
  /** Only ever set for an AI decision — a rule match has no confidence to report. */
  confidencePercent: number | null;
}

/**
 * The seven per-day counts that used to back the overview sparkline were dropped
 * when the 14-day volume chart replaced it: `getMessageLoadSeries` in
 * dashboardMetrics.ts now derives both the daily and the hourly series from a
 * single aggregate query.
 */
export async function getRecentMessageActivity(nowMs: number) {
  const since24h = hoursAgo(24, nowMs);

  const [rows, messagesLast24h] = await Promise.all([
    prisma.message.findMany({
      orderBy: { timestampWa: "desc" },
      take: 10,
      select: {
        id: true,
        senderPhone: true,
        senderName: true,
        body: true,
        direction: true,
        processingStatus: true,
        timestampWa: true,
        account: { select: { label: true } },
        group: { select: { name: true } },
        // At most one of these two is ever meaningful for a given message — the AI layer only
        // runs on a genuine NO_MATCH from the rule engine — so reading both and letting the
        // fallback decision win when present is cheap and never ambiguous.
        executions: { orderBy: { createdAt: "desc" }, take: 1, select: { decision: true } },
        aiFallbackDecision: { select: { outcome: true, confidenceScore: true } },
      },
    }),
    prisma.message.count({ where: { direction: "INCOMING", createdAt: { gte: since24h } } }),
  ]);

  const recentMessages = rows.map((row) => ({
    id: row.id,
    senderPhone: row.senderPhone,
    senderName: row.senderName,
    body: row.body,
    direction: row.direction,
    processingStatus: row.processingStatus,
    timestampWa: row.timestampWa,
    accountLabel: row.account.label,
    groupName: row.group?.name ?? null,
    trace: deriveTrace(row),
  }));

  return { recentMessages, messagesLast24h };
}

/**
 * What actually happened to one message, in one sentence — the "Automation Trace" column on the
 * Live Traffic table. Precedence matters: an AI outcome is read first because it is only ever
 * present on a message the rule engine already returned NO_MATCH for, so it is strictly more
 * informative than repeating "No rule matched".
 */
function deriveTrace(row: {
  direction: string;
  processingStatus: string;
  executions: Array<{ decision: string }>;
  aiFallbackDecision: { outcome: string; confidenceScore: number | null } | null;
}): MessageTrace {
  if (row.aiFallbackDecision) {
    const replied = row.aiFallbackDecision.outcome === "AI_REPLIED";
    return {
      // Same wording as the "AI answers and handovers" chart and the AI Activity log, so a reader
      // never has to reconcile two names for the same outcome.
      label: replied ? "AI replied" : "Handed to a person",
      tone: replied ? "blue" : "yellow",
      confidencePercent: row.aiFallbackDecision.confidenceScore,
    };
  }

  if (row.executions.length > 0) {
    const decision = row.executions[0].decision;
    const tone: MessageTrace["tone"] =
      decision === "AUTO_REPLY" || decision === "ACTIONED"
        ? "green"
        : decision === "SUPPORT_REQUIRED"
          ? "yellow"
          : decision === "IGNORE" || decision === "STOPPED"
            ? "gray"
            : "blue"; // NO_MATCH — neutral, not yet a problem on its own
    return { label: decisionLabel(decision), tone, confidencePercent: null };
  }

  // Direction alone still tells a true story when no execution row exists at all — an OUTGOING
  // echo of our own send is never automated, and the loop-prevention path for it never runs.
  if (row.direction === "OUTGOING") return { label: "Sent by us", tone: "gray", confidencePercent: null };
  if (row.processingStatus === "FAILED") return { label: "Processing failed", tone: "red", confidencePercent: null };
  return { label: "Queued", tone: "gray", confidencePercent: null };
}
