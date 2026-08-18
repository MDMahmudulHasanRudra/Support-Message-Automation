import { prisma, resolveWhatsAppAccount, isResolutionError } from "@support-automation/db";
import type { EscalationStatus, PatternCandidateStatus, WhatsAppServiceKey } from "@prisma/client";
import { getDhakaDayRange } from "@/lib/supportActivityPeriod";
import { getEveryActivityCount, getUniqueGroupCount } from "@/server/supportActivityReports";

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

export async function getRecentMessageActivity(nowMs: number) {
  const since24h = hoursAgo(24, nowMs);
  const dayStarts: Date[] = [];
  for (let i = 6; i >= 0; i--) {
    dayStarts.push(new Date(new Date(nowMs - i * 24 * 60 * 60 * 1000).setHours(0, 0, 0, 0)));
  }
  const dayBoundaries = [...dayStarts, new Date(new Date(nowMs).setHours(0, 0, 0, 0) + 24 * 60 * 60 * 1000)];

  const [recentMessages, messagesLast24h, ...dailyIncomingCounts] = await Promise.all([
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
      },
    }),
    prisma.message.count({ where: { direction: "INCOMING", createdAt: { gte: since24h } } }),
    ...dayStarts.map((start, i) =>
      prisma.message.count({
        where: { direction: "INCOMING", createdAt: { gte: start, lt: dayBoundaries[i + 1] } },
      }),
    ),
  ]);

  return { recentMessages, messagesLast24h, sparkline: dailyIncomingCounts };
}
