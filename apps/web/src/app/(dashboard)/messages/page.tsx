import { prisma } from "@support-automation/db";
import type { Prisma } from "@prisma/client";
import { requireSession } from "@/server/auth";
import { PageHeader, Pagination } from "@/components/ui";
import { MessagesFilterBar, type MessageFilters } from "./MessagesFilterBar";
import { MessagesTable, type MessageRow } from "./MessagesTable";

const PAGE_SIZE = 50;

interface MessagesSearchParams extends MessageFilters {
  page?: string;
}

export default async function MessagesPage({ searchParams }: { searchParams: Promise<MessagesSearchParams> }) {
  await requireSession();
  const params = await searchParams;
  const page = Math.max(1, Number(params.page ?? "1") || 1);

  const where: Prisma.MessageWhereInput = {};
  if (params.accountId) where.accountId = params.accountId;
  if (params.group) where.group = { name: { contains: params.group, mode: "insensitive" } };
  if (params.sender) {
    where.OR = [
      { senderPhone: { contains: params.sender, mode: "insensitive" } },
      { senderName: { contains: params.sender, mode: "insensitive" } },
    ];
  }
  if (params.dateFrom || params.dateTo) {
    where.timestampWa = {
      ...(params.dateFrom ? { gte: new Date(params.dateFrom) } : {}),
      ...(params.dateTo ? { lte: new Date(`${params.dateTo}T23:59:59.999Z`) } : {}),
    };
  }
  const executionFilter: Prisma.AutomationExecutionWhereInput = {};
  if (params.decision) executionFilter.decision = params.decision;
  if (params.ruleId) executionFilter.ruleId = params.ruleId;
  if (Object.keys(executionFilter).length > 0) where.executions = { some: executionFilter };
  if (params.autoReplyStatus) {
    where.outboundReplies = { some: { actionType: "AUTO_REPLY", status: params.autoReplyStatus as Prisma.EnumOutboundMessageStatusFilter["equals"] } };
  }
  if (params.notificationStatus) {
    where.notifications = { some: { status: params.notificationStatus as Prisma.EnumNotificationStatusFilter["equals"] } };
  }

  const hasActiveFilters = Boolean(
    params.accountId || params.group || params.sender || params.dateFrom || params.dateTo ||
    params.decision || params.ruleId || params.autoReplyStatus || params.notificationStatus,
  );

  const [messages, totalCount, accounts, rules] = await Promise.all([
    prisma.message.findMany({
      where,
      orderBy: { timestampWa: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        account: { select: { label: true } },
        group: { select: { name: true } },
        executions: { orderBy: { matchedAt: "desc" }, take: 1, select: { decision: true, rule: { select: { name: true } } } },
        outboundReplies: { where: { actionType: "AUTO_REPLY" }, take: 1, select: { status: true } },
        notifications: { select: { type: true, status: true } },
      },
    }),
    prisma.message.count({ where }),
    prisma.whatsAppAccount.findMany({ select: { id: true, label: true }, orderBy: { label: "asc" } }),
    prisma.automationRule.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);

  const rows: MessageRow[] = messages.map((m) => ({
    id: m.id,
    senderPhone: m.senderPhone,
    senderName: m.senderName,
    isFromTeamMember: m.isFromTeamMember,
    direction: m.direction,
    body: m.body,
    processingStatus: m.processingStatus,
    timestampWa: m.timestampWa,
    accountLabel: m.account.label,
    groupName: m.group?.name ?? null,
    ruleName: m.executions[0]?.rule?.name ?? null,
    decision: m.executions[0]?.decision ?? null,
    autoReplyStatus: m.outboundReplies[0]?.status ?? null,
    notifications: m.notifications,
  }));

  return (
    <div>
      <PageHeader title="All Messages" description="Every message across every account, with rule decisions, auto-reply, and notification status." />

      <MessagesFilterBar
        defaults={params}
        options={{ accounts, rules }}
      />

      <MessagesTable messages={rows} hasActiveFilters={hasActiveFilters} />

      {totalCount > 0 ? (
        <Pagination page={page} pageSize={PAGE_SIZE} total={totalCount} buildHref={(p) => buildPageHref(params, p)} />
      ) : null}
    </div>
  );
}

function buildPageHref(params: MessagesSearchParams, page: number): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key !== "page" && typeof value === "string" && value) qs.set(key, value);
  }
  if (page > 1) qs.set("page", String(page));
  return `/messages?${qs.toString()}`;
}
