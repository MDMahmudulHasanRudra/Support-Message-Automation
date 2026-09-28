/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */

import { prisma } from "@/server/db";
import { NotificationStatus, OutboundMessageStatus, type Prisma } from "@prisma/client";
import { requireAccess } from "@/server/authorize";
import { Alert, HelpButton, HelpSection, PageHeader, Pagination } from "@/components/ui";
import { parseDhakaDayFromInput } from "@/lib/supportActivityPeriod";
import { enumParam } from "@/lib/enumParam";
import { MessagesFilterBar, type MessageFilters } from "./MessagesFilterBar";
import { MessagesTable, type MessageRow } from "./MessagesTable";

const PAGE_SIZE_OPTIONS = [50, 100, 250] as const;
const DEFAULT_PAGE_SIZE = 50;

interface MessagesSearchParams extends MessageFilters {
  page?: string;
  pageSize?: string;
}

export default async function MessagesPage({ searchParams }: { searchParams: Promise<MessagesSearchParams> }) {
  await requireAccess("messages.view");
  const params = await searchParams;
  const page = Math.max(1, Number(params.page ?? "1") || 1);
  const requestedPageSize = Number(params.pageSize ?? DEFAULT_PAGE_SIZE);
  const PAGE_SIZE = PAGE_SIZE_OPTIONS.includes(requestedPageSize as (typeof PAGE_SIZE_OPTIONS)[number])
    ? requestedPageSize
    : DEFAULT_PAGE_SIZE;

  const where: Prisma.MessageWhereInput = {};
  if (params.accountId) where.accountId = params.accountId;
  if (params.group) where.group = { name: { contains: params.group, mode: "insensitive" } };
  // AND-ed rather than merged into a single OR: sender and text are separate questions, and
  // putting both in one `where.OR` would widen the result instead of narrowing it — "this sender
  // OR anyone who mentioned this word" is never what an operator means.
  const clauses: Prisma.MessageWhereInput[] = [];
  if (params.sender) {
    clauses.push({
      OR: [
        { senderPhone: { contains: params.sender, mode: "insensitive" } },
        { senderName: { contains: params.sender, mode: "insensitive" } },
      ],
    });
  }
  if (params.text?.trim()) {
    clauses.push({ body: { contains: params.text.trim(), mode: "insensitive" } });
  }
  if (clauses.length > 0) where.AND = clauses;
  // Both bounds name Dhaka calendar days, not UTC ones, so a one-day filter returns that day as
  // the operator lived it. An unparseable value is dropped and reported rather than handed to
  // Prisma as an Invalid Date, which threw and replaced the page with a generic error screen that
  // gave no hint the date filter was at fault.
  // Read once at the top of the request, matching how the Overview page takes its clock — a
  // rolling window computed twice inside one render could straddle a second boundary.
  // eslint-disable-next-line react-hooks/purity -- server component runs fresh per request; not subject to render-purity rules
  const nowMs = Date.now();

  // Whitelisted rather than parsed freely: this is a link target, and an arbitrary `within=9999`
  // from a pasted URL should fall through to "no window" rather than scan the whole table.
  const withinHours =
    params.within === "24h" ? 24 : params.within === "7d" ? 24 * 7 : params.within === "14d" ? 24 * 14 : null;

  const dateFromDay = parseDhakaDayFromInput(params.dateFrom);
  const dateToDay = parseDhakaDayFromInput(params.dateTo);
  const invalidDateFilters = [
    params.dateFrom && !dateFromDay ? "From" : null,
    params.dateTo && !dateToDay ? "To" : null,
  ].filter((label): label is string => label !== null);
  if (dateFromDay || dateToDay) {
    where.timestampWa = {
      ...(dateFromDay ? { gte: dateFromDay.start } : {}),
      ...(dateToDay ? { lt: dateToDay.end } : {}),
    };
  } else if (withinHours) {
    // A ROLLING window, which the day bounds above cannot express — and that gap is why this
    // exists. The Overview's "(24h)" tiles count the last twenty-four hours from now, so a tile
    // linking here with `dateFrom=today` would land on a different set than the number it showed:
    // wrong before lunch, wronger at midnight. Anything that has to reproduce the dashboard's own
    // query by hand is the failure this whole feature is meant to remove.
    //
    // Explicit dates win when both are present: a shorthand must never quietly override something
    // somebody typed.
    where.timestampWa = { gte: new Date(nowMs - withinHours * 60 * 60 * 1000) };
  }
  const executionFilter: Prisma.AutomationExecutionWhereInput = {};
  if (params.decision) executionFilter.decision = params.decision;
  if (params.ruleId) executionFilter.ruleId = params.ruleId;
  if (Object.keys(executionFilter).length > 0) where.executions = { some: executionFilter };
  // Both validated against the real enum: the raw values were cast straight into the query, so a
  // stale Overview link or a hand-edited URL threw a Prisma validation error and replaced the page.
  const autoReplyStatus = enumParam(OutboundMessageStatus, params.autoReplyStatus);
  const notificationStatus = enumParam(NotificationStatus, params.notificationStatus);
  if (autoReplyStatus) {
    where.outboundReplies = { some: { actionType: "AUTO_REPLY", status: autoReplyStatus } };
  }
  if (notificationStatus) {
    where.notifications = { some: { status: notificationStatus } };
  }

  const hasActiveFilters = Boolean(
    params.accountId || params.group || params.sender || params.text || params.dateFrom || params.dateTo ||
    params.decision || params.ruleId || autoReplyStatus || notificationStatus || withinHours,
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

      {invalidDateFilters.length > 0 ? (
        <div className="mb-6">
          <Alert tone="warning" title="Date filter ignored">
            {invalidDateFilters.length > 1
              ? "From and To are not valid dates."
              : `${invalidDateFilters[0]} is not a valid date.`}{" "}
            Pick one with the date picker (YYYY-MM-DD) — the results below are unfiltered by date.
          </Alert>
        </div>
      ) : null}

      <MessagesFilterBar
        defaults={params}
        options={{ accounts, rules }}
      />

      <MessagesTable messages={rows} hasActiveFilters={hasActiveFilters} />

      {totalCount > 0 ? (
        <Pagination
          page={page}
          pageSize={PAGE_SIZE}
          total={totalCount}
          buildHref={(p) => buildPageHref(params, p, PAGE_SIZE)}
          pageSizeOptions={[...PAGE_SIZE_OPTIONS]}
          buildPageSizeHref={(size) => buildPageHref(params, 1, size)}
          sticky
        />
      ) : null}
    </div>
  );
}

function buildPageHref(params: MessagesSearchParams, page: number, pageSize?: number): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key !== "page" && key !== "pageSize" && typeof value === "string" && value) qs.set(key, value);
  }
  if (page > 1) qs.set("page", String(page));
  if (pageSize && pageSize !== DEFAULT_PAGE_SIZE) qs.set("pageSize", String(pageSize));
  return `/messages?${qs.toString()}`;
}
