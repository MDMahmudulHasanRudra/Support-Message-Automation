/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import type { Prisma } from "@prisma/client";
import { Badge, type BadgeColor, Button, ButtonLink, EmptyState, FilterBar, HelpButton, HelpSection, PageHeader, Pagination, Select, Table, Td, Th, Tooltip } from "@/components/ui";
import { formatDateTime } from "@/lib/date";
import { TestNotificationForm } from "./TestNotificationForm";
import { RetryNotificationButton } from "./RetryNotificationButton";

const PAGE_SIZE = 50;
const STATUSES = ["PENDING", "SENT", "FAILED", "RETRYING"] as const;

interface NotificationsSearchParams {
  status?: string;
  page?: string;
}

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<NotificationsSearchParams>;
}) {
  await requireSession();
  const filters = await searchParams;

  const where: Prisma.NotificationWhereInput = {};
  if (filters.status && STATUSES.includes(filters.status as (typeof STATUSES)[number])) {
    where.status = filters.status as Prisma.EnumNotificationStatusFilter["equals"];
  }

  // Paginated and filterable. It was a bare "newest 100", which on a delivery log is exactly
  // backwards: the notification you come here to investigate is usually a failed one, and failures
  // are the rows most likely to have scrolled past the cap.
  const page = Math.max(1, Number(filters.page ?? "1") || 1);
  const [notifications, totalCount, failedCount] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { status: "FAILED" } }),
  ]);

  const buildHref = (nextPage: number) => {
    const qs = new URLSearchParams();
    if (filters.status) qs.set("status", filters.status);
    if (nextPage > 1) qs.set("page", String(nextPage));
    const query = qs.toString();
    return query ? `/notifications?${query}` : "/notifications";
  };

  return (
    <div>
      <PageHeader
        title="Notifications"
        description={`${totalCount.toLocaleString()} alert${totalCount === 1 ? "" : "s"} to Teams and WhatsApp support groups, newest first.`}
        actions={
          <HelpButton moduleTitle="Notifications">
            <HelpSection title="What this page is for — and isn't">
              <p>
                This is a delivery log/monitor only. It does not configure where alerts go (that's the
                Settings page's Teams webhook URL and WhatsApp group picker), and it does not decide
                which WhatsApp account sends them (that's Accounts → Routing). Come here only to see
                whether an alert actually went out, and to retry ones that failed.
              </p>
            </HelpSection>
            <HelpSection title="Send Test Notification">
              <p>
                Only tests the Microsoft Teams channel — it does not test WhatsApp delivery at all. If
                no Teams webhook URL is configured on Settings, this fails immediately with a clear
                error telling you to set one first.
              </p>
            </HelpSection>
            <HelpSection title="Runs independently of the kill switch">
              <p>
                Notifications keep sending even while automation is paused — pausing only stops
                automatic client replies, it doesn't silence alerts to your own team.
              </p>
            </HelpSection>
            <HelpSection title="Retry">
              <p>
                Resets a FAILED row back to PENDING so the dispatcher (which runs every few seconds)
                picks it up again — it resends the exact same stored message, it doesn't re-run the
                rule that originally triggered it. Failed sends already auto-retry up to 3 times before
                landing here; a row stuck in RETRYING self-heals after a couple of minutes on its own.
              </p>
            </HelpSection>
            <HelpSection title="Diagnosing a WhatsApp alert that never appears here">
              <p>
                If a rule's NOTIFY_WHATSAPP action can't resolve which account to send through (nothing
                configured and no Primary, or a strict routing policy with no fallback), it fails
                <em> before</em> a row is even created — so you won't find it in this table at all.
                Check System Logs (scope "whatsapp-routing" or "pipeline") or the Account Routing page's
                own error display instead.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />

      <TestNotificationForm />

      <form method="GET">
        <FilterBar>
          <Select name="status" defaultValue={filters.status ?? ""} className="w-40">
            <option value="">All statuses</option>
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </Select>
          <Button type="submit" size="sm">
            Filter
          </Button>
          {/* Failures are why anyone opens this page, so they get one click rather than a
              dropdown plus a submit. */}
          {failedCount > 0 && filters.status !== "FAILED" ? (
            <ButtonLink href="/notifications?status=FAILED" variant="ghost" size="sm">
              Show {failedCount} failed
            </ButtonLink>
          ) : null}
          {filters.status ? (
            <ButtonLink href="/notifications" variant="ghost" size="sm">
              Clear
            </ButtonLink>
          ) : null}
        </FilterBar>
      </form>

      {notifications.length === 0 ? (
        <EmptyState>
          {filters.status ? `No ${filters.status.toLowerCase()} notifications.` : "No notifications yet."}
        </EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Time</Th>
              <Th>Type</Th>
              <Th>Destination</Th>
              <Th>Status</Th>
              <Th>Attempts</Th>
              <Th>Failure Reason</Th>
              <Th>Manage</Th>
            </tr>
          </thead>
          <tbody>
            {notifications.map((n) => (
              <tr key={n.id}>
                <Td className="whitespace-nowrap font-[family-name:var(--font-mono)] text-xs">
                  {formatDateTime(n.createdAt)}
                </Td>
                <Td>{n.type}</Td>
                <Td className="max-w-xs">
                  <Tooltip content={n.destination}>
                    <span className="block max-w-xs truncate">{n.destination}</span>
                  </Tooltip>
                </Td>
                <Td>
                  <Badge color={statusColor(n.status)} dot>
                    {n.status}
                  </Badge>
                </Td>
                <Td className="tabular-nums">{n.attemptCount}</Td>
                <Td className="max-w-xs">
                  {n.failureReason ? (
                    <Tooltip content={n.failureReason}>
                      <span className="block max-w-xs truncate">{n.failureReason}</span>
                    </Tooltip>
                  ) : (
                    "—"
                  )}
                </Td>
                <Td>{n.status === "FAILED" ? <RetryNotificationButton id={n.id} /> : "—"}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {notifications.length > 0 ? (
        <Pagination page={page} pageSize={PAGE_SIZE} total={totalCount} buildHref={buildHref} />
      ) : null}
    </div>
  );
}

function statusColor(status: string): BadgeColor {
  if (status === "SENT") return "green";
  if (status === "FAILED") return "red";
  return "yellow";
}
