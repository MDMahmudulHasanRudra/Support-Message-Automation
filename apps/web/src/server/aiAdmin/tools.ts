import type Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@support-automation/db";
import { getDhakaDayRange } from "@/lib/supportActivityPeriod";
import {
  getEveryActivityCount,
  getPerTeamMemberBreakdown,
  getUniqueGroupCount,
} from "@/server/supportActivityReports";

export interface AiAdminTool {
  name: string;
  description: string;
  inputSchema: Anthropic.Tool.InputSchema;
  handler: (input: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Read-only tool registry for the floating AI Admin Assistant. Every handler here is a plain
 * Prisma read — no tool in this file can change any data. There is no write-tool/confirmation
 * layer yet (a deliberate v1 scope cut, documented in the plan file); adding one later means
 * adding a `kind: "write"` variant here plus the confirmation state machine, not rewriting this
 * registry. Every handler calls the exact same read helpers the dashboard pages themselves use
 * (supportActivityReports.ts) rather than re-deriving queries, so the assistant's answers can
 * never drift from what a human sees on the actual pages.
 */
export const AI_ADMIN_TOOLS: AiAdminTool[] = [
  {
    name: "get_support_stats",
    description:
      "Get today's Support Activity Tracking summary: whether the feature is enabled, today's total activities, and today's number of distinct supported groups.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const settings = await prisma.supportActivitySettings.upsert({
        where: { id: "global" },
        update: {},
        create: { id: "global" },
      });
      const today = getDhakaDayRange(new Date());
      const [todayActivities, todaySupportedGroups] = await Promise.all([
        getEveryActivityCount(today),
        getUniqueGroupCount(today),
      ]);
      return { enabled: settings.enabled, countingMode: settings.countingMode, todayActivities, todaySupportedGroups };
    },
  },
  {
    name: "get_top_support_members",
    description: "Get today's support team members ranked by number of activities, most active first.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "Max members to return (default 10)." } },
    },
    handler: async (input) => {
      const limit = typeof input.limit === "number" && input.limit > 0 ? Math.min(input.limit, 50) : 10;
      const today = getDhakaDayRange(new Date());
      const breakdown = await getPerTeamMemberBreakdown(today);
      return breakdown.slice(0, limit);
    },
  },
  {
    name: "get_whatsapp_accounts",
    description: "List every connected WhatsApp account and its connection status.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const accounts = await prisma.whatsAppAccount.findMany({
        select: { label: true, status: true, isPrimary: true, phoneNumber: true },
      });
      return accounts;
    },
  },
  {
    name: "get_groups",
    description: "List monitored WhatsApp groups (name, priority tier if any, whether monitored/active).",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "Max groups to return (default 25)." } },
    },
    handler: async (input) => {
      const limit = typeof input.limit === "number" && input.limit > 0 ? Math.min(input.limit, 100) : 25;
      const groups = await prisma.whatsAppGroup.findMany({
        where: { isActive: true },
        take: limit,
        orderBy: { name: "asc" },
        select: { name: true, isMonitored: true, priority: true },
      });
      return groups;
    },
  },
  {
    name: "get_priority_cases",
    description: "Get a summary of open Priority Support Escalation cases (count by status, oldest waiting).",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const activeStatuses = [
        "NEW",
        "MONITORING",
        "WAITING_FOR_HUMAN",
        "SECOND_ALERT",
        "MEMBER_ESCALATED",
        "ADMIN_ESCALATED",
        "FOLLOW_UP",
      ] as const;
      const [openCases, oldest] = await Promise.all([
        prisma.supportEscalationCase.groupBy({ by: ["status"], where: { status: { in: [...activeStatuses] } }, _count: { status: true } }),
        prisma.supportEscalationCase.findFirst({
          where: { status: { in: [...activeStatuses] } },
          orderBy: { lastCustomerMessageAt: "asc" },
          select: { lastCustomerMessageAt: true, group: { select: { name: true } } },
        }),
      ]);
      return {
        openCaseCount: openCases.reduce((sum, g) => sum + g._count.status, 0),
        byStatus: openCases.map((g) => ({ status: g.status, count: g._count.status })),
        oldestWaitingGroup: oldest?.group.name ?? null,
        oldestWaitingSince: oldest?.lastCustomerMessageAt ?? null,
      };
    },
  },
  {
    name: "get_ai_settings",
    description: "Get the current AI Learning settings (which switches are enabled) and how many AI providers are configured/active.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const [settings, activeProviderCount, totalProviderCount] = await Promise.all([
        prisma.aiSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } }),
        prisma.aiProvider.count({ where: { status: "ACTIVE" } }),
        prisma.aiProvider.count(),
      ]);
      return {
        aiEngineEnabled: settings.aiEngineEnabled,
        learningEnabled: settings.learningEnabled,
        autoResponseEnabled: settings.autoResponseEnabled,
        activeProviderCount,
        totalProviderCount,
      };
    },
  },
  {
    name: "get_broadcast_jobs",
    description: "Get a summary of Group Message Sender and Add-to-Groups job statuses (how many running/queued/completed).",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const [broadcastGroups, addGroups] = await Promise.all([
        prisma.groupBroadcastJob.groupBy({ by: ["status"], _count: { status: true } }),
        prisma.groupParticipantAddJob.groupBy({ by: ["status"], _count: { status: true } }),
      ]);
      return {
        broadcastJobsByStatus: broadcastGroups.map((g) => ({ status: g.status, count: g._count.status })),
        addToGroupJobsByStatus: addGroups.map((g) => ({ status: g.status, count: g._count.status })),
      };
    },
  },
];

export const AI_ADMIN_TOOL_MAP = new Map(AI_ADMIN_TOOLS.map((t) => [t.name, t]));
