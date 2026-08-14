/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */
import { prisma } from "@support-automation/db";
import type { Prisma } from "@prisma/client";
import { requireSession } from "@/server/auth";
import { HelpButton, HelpSection, PageHeader, Pagination } from "@/components/ui";
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
      <PageHeader
        title="All Messages"
        description="Every message across every account, with rule decisions, auto-reply, and notification status."
        actions={
          <HelpButton moduleTitle="Messages">
            <HelpSection title="What this page is for">
              <p>
                A read-only, filterable log of every WhatsApp message the system has seen. "Needs
                Attention" and "Ignored Messages" in the sidebar are this same page, just pre-filtered
                by Decision — there's no separate storage for them.
              </p>
            </HelpSection>
            <HelpSection title="Status vs. Decision — two different things">
              <p>
                <strong>Status</strong> is the message's own processing lifecycle: PENDING, PROCESSED,
                IGNORED, or FAILED. <strong>Decision</strong> is what the automation rule engine decided
                to do: IGNORE (a rule explicitly said to do nothing), AUTO_REPLY (a reply was sent),
                SUPPORT_REQUIRED (flagged for human attention — this is the Needs Attention filter),
                STOPPED, ACTIONED (some other action ran), or NO_MATCH (no rule matched at all).
              </p>
            </HelpSection>
            <HelpSection title="View-only">
              <p>
                There are no bulk actions or edits here — click "View" on any row to see full details:
                every rule that was considered and why it did or didn't match, the exact auto-reply
                that was queued (if any) and its delivery status, and any notifications triggered.
              </p>
            </HelpSection>
            <HelpSection title="Gotcha: a message ignored by the team-member default">
              <p>
                If nobody wrote a rule for it, a message from an active Internal Team Member is
                automatically ignored by the system. It shows up here as Decision = IGNORE with Rule
                Matched = "—" (no real rule fired) — the message detail page's trace shows this as a
                system default, not a configured rule.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />

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
