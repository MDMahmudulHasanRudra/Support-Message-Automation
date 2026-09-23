/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */
import Link from "next/link";
import { prisma } from "@support-automation/db";
import type { OutboundMessageStatus, Prisma } from "@prisma/client";
import { pageAccess } from "@/server/authorize";
import { Alert, Badge, type BadgeColor, Button, EmptyState, FilterBar, HelpButton, HelpSection, Input, PageHeader, Pagination, Select, Table, Td, Th, ViewOnlyNotice } from "@/components/ui";
import { formatDateTime } from "@/lib/date";
import { parseDhakaDayFromInput } from "@/lib/supportActivityPeriod";

const STATUS_OPTIONS = [
  "PENDING",
  "PROCESSING",
  "SENT",
  "FAILED",
  "CANCELLED",
  "RATE_LIMITED",
  "SKIPPED",
] as const satisfies readonly OutboundMessageStatus[];

/** One 1,848-group broadcast produces 1,848 rows, so a fixed 200 showed roughly a tenth of a
 *  single job — and said nothing about the rest. */
const PAGE_SIZE_OPTIONS = [50, 200, 500] as const;
const DEFAULT_PAGE_SIZE = 200;

interface HistorySearchParams {
  accountId?: string;
  group?: string;
  status?: string;
  from?: string;
  to?: string;
  page?: string;
  pageSize?: string;
}

export default async function GroupBroadcastHistoryPage({
  searchParams,
}: {
  searchParams: Promise<HistorySearchParams>;
}) {
  const { canManage } = await pageAccess("bulk_messaging.view", "bulk_messaging.manage");
  const filters = await searchParams;

  const accounts = await prisma.whatsAppAccount.findMany({ orderBy: { label: "asc" } });

  const where: Prisma.OutboundMessageWhereInput = { actionType: "GROUP_BROADCAST" };
  if (filters.accountId) where.accountId = filters.accountId;
  // Whitelisted, not cast. The raw value went straight to Prisma, so a stale or hand-edited link
  // threw a validation error and replaced the whole page — the same failure the date filter just
  // below was already fixed for. `satisfies` on the list proves every entry is a real status, so a
  // typo cannot reach Prisma; it does not force the list to cover a status added to the enum later.
  const status = (STATUS_OPTIONS as readonly string[]).includes(filters.status ?? "")
    ? (filters.status as OutboundMessageStatus)
    : null;
  if (status) where.status = status;
  if (filters.group) where.groupNameSnapshot = { contains: filters.group, mode: "insensitive" };
  // Dhaka calendar days, and an unparseable value is dropped and reported instead of reaching
  // Prisma as an Invalid Date — that threw a validation error and replaced the whole page.
  const fromDay = parseDhakaDayFromInput(filters.from);
  const toDay = parseDhakaDayFromInput(filters.to);
  const invalidDateFilters = [
    filters.from && !fromDay ? "From" : null,
    filters.to && !toDay ? "To" : null,
  ].filter((label): label is string => label !== null);
  if (fromDay || toDay) {
    where.createdAt = {
      ...(fromDay ? { gte: fromDay.start } : {}),
      ...(toDay ? { lt: toDay.end } : {}),
    };
  }

  const page = Math.max(1, Number(filters.page ?? "1") || 1);
  const requestedPageSize = Number(filters.pageSize ?? DEFAULT_PAGE_SIZE);
  const PAGE_SIZE = PAGE_SIZE_OPTIONS.includes(requestedPageSize as (typeof PAGE_SIZE_OPTIONS)[number])
    ? requestedPageSize
    : DEFAULT_PAGE_SIZE;

  const [messages, totalCount] = await Promise.all([
    prisma.outboundMessage.findMany({
      where,
      include: { account: { select: { label: true } }, createdBy: { select: { name: true, email: true } } },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.outboundMessage.count({ where }),
  ]);

  const buildHref = (nextPage: number, nextPageSize = PAGE_SIZE): string => {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (key !== "page" && key !== "pageSize" && typeof value === "string" && value) qs.set(key, value);
    }
    if (nextPage > 1) qs.set("page", String(nextPage));
    if (nextPageSize !== DEFAULT_PAGE_SIZE) qs.set("pageSize", String(nextPageSize));
    const query = qs.toString();
    return query ? `/group-message-sender/history?${query}` : "/group-message-sender/history";
  };

  return (
    <div>
      <PageHeader
        title="Group Message Sending History"
        description="Every individual group send from the Group Message Sender, across all jobs."
        actions={
          <HelpButton moduleTitle="Group Message Sending History">
            <HelpSection title="What this page is for">
              <p>
                A flat audit log of every individual group send the Group Message Sender has ever
                produced, across all jobs — not grouped by job. Click "View" on any row's Job link to
                jump to that send's full job progress page.
              </p>
            </HelpSection>
            <HelpSection title="Status meanings">
              <p>
                SENT and FAILED are self-explanatory. SKIPPED means a live membership re-check failed
                right before sending (the account wasn't actually still in that group). CANCELLED means
                the job was stopped (manually, or by the kill switch) before this row's turn came up.
                RATE_LIMITED means an account-wide limit was hit at send time, independent of the job's
                own pacing.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />

      {canManage ? null : <ViewOnlyNotice />}

      {invalidDateFilters.length > 0 ? (
        <div className="mb-6">
          <Alert tone="warning" title="Date filter ignored">
            {invalidDateFilters.length > 1
              ? "From and To are not valid dates."
              : `${invalidDateFilters[0]} is not a valid date.`}{" "}
            Pick one with the date picker (YYYY-MM-DD) — the rows below are unfiltered by date.
          </Alert>
        </div>
      ) : null}

      <form method="GET">
        <FilterBar>
          <Select name="accountId" defaultValue={filters.accountId ?? ""} className="w-40">
            <option value="">All accounts</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </Select>
          <Select name="status" defaultValue={status ?? ""} className="w-36">
            <option value="">All statuses</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
          <Input name="group" placeholder="Group name contains…" defaultValue={filters.group ?? ""} className="w-44" />
          <Input name="from" type="date" defaultValue={filters.from ?? ""} className="w-36" />
          <Input name="to" type="date" defaultValue={filters.to ?? ""} className="w-36" />
          <Button type="submit" size="sm">
            Filter
          </Button>
          <Link
            href="/group-message-sender/history"
            className="text-sm text-[color:var(--color-muted-foreground)] underline hover:text-[color:var(--color-foreground)]"
          >
            Clear
          </Link>
        </FilterBar>
      </form>

      {messages.length === 0 ? (
        <EmptyState>No group broadcast messages match these filters.</EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Date/Time</Th>
              <Th>Account</Th>
              <Th>Group</Th>
              <Th>Message</Th>
              <Th>Status</Th>
              <Th>Retries</Th>
              <Th>Failure Reason</Th>
              <Th>Provider ID</Th>
              <Th>Created By</Th>
              <Th>Job</Th>
            </tr>
          </thead>
          <tbody>
            {messages.map((m) => (
              <tr key={m.id}>
                <Td className="whitespace-nowrap font-[family-name:var(--font-mono)] text-xs">
                  {formatDateTime(m.createdAt)}
                </Td>
                <Td>{m.account.label}</Td>
                <Td>{m.groupNameSnapshot ?? "—"}</Td>
                <Td className="max-w-xs truncate">{m.body}</Td>
                <Td>
                  <Badge color={statusColor(m.status)} dot>
                    {m.status}
                  </Badge>
                </Td>
                <Td className="tabular-nums">{m.attemptCount}</Td>
                <Td className="max-w-xs">{m.failureReason ?? "—"}</Td>
                <Td className="font-[family-name:var(--font-mono)] text-xs">{m.providerMessageId ?? "—"}</Td>
                <Td>{m.createdBy?.name ?? m.createdBy?.email ?? "—"}</Td>
                <Td>
                  {m.broadcastJobId ? (
                    <Link
                      href={`/group-message-sender/jobs/${m.broadcastJobId}`}
                      className="link"
                    >
                      View
                    </Link>
                  ) : (
                    "—"
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {messages.length > 0 ? (
        <Pagination
          page={page}
          pageSize={PAGE_SIZE}
          total={totalCount}
          buildHref={(p) => buildHref(p)}
          pageSizeOptions={[...PAGE_SIZE_OPTIONS]}
          buildPageSizeHref={(size) => buildHref(1, size)}
          sticky
        />
      ) : null}
    </div>
  );
}

function statusColor(status: string): BadgeColor {
  if (status === "SENT") return "green";
  if (status === "FAILED") return "red";
  if (status === "SKIPPED" || status === "CANCELLED") return "gray";
  if (status === "PROCESSING") return "blue";
  return "yellow";
}
