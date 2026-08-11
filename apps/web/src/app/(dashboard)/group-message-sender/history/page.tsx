import Link from "next/link";
import { prisma } from "@support-automation/db";
import type { OutboundMessageStatus, Prisma } from "@prisma/client";
import { requireSession } from "@/server/auth";
import { Badge, type BadgeColor, Button, EmptyState, FilterBar, Input, PageHeader, Select, Table, Td, Th } from "@/components/ui";

const STATUS_OPTIONS = ["PENDING", "PROCESSING", "SENT", "FAILED", "CANCELLED", "RATE_LIMITED", "SKIPPED"] as const;

interface HistorySearchParams {
  accountId?: string;
  group?: string;
  status?: string;
  from?: string;
  to?: string;
}

export default async function GroupBroadcastHistoryPage({
  searchParams,
}: {
  searchParams: Promise<HistorySearchParams>;
}) {
  await requireSession();
  const filters = await searchParams;

  const accounts = await prisma.whatsAppAccount.findMany({ orderBy: { label: "asc" } });

  const where: Prisma.OutboundMessageWhereInput = { actionType: "GROUP_BROADCAST" };
  if (filters.accountId) where.accountId = filters.accountId;
  if (filters.status) where.status = filters.status as OutboundMessageStatus;
  if (filters.group) where.groupNameSnapshot = { contains: filters.group, mode: "insensitive" };
  if (filters.from || filters.to) {
    where.createdAt = {
      ...(filters.from ? { gte: new Date(filters.from) } : {}),
      ...(filters.to ? { lte: new Date(`${filters.to}T23:59:59.999Z`) } : {}),
    };
  }

  const messages = await prisma.outboundMessage.findMany({
    where,
    include: { account: { select: { label: true } }, createdBy: { select: { name: true, email: true } } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return (
    <div>
      <PageHeader
        title="Group Message Sending History"
        description="Every individual group send from the Group Message Sender, across all jobs."
      />

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
          <Select name="status" defaultValue={filters.status ?? ""} className="w-36">
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
                  {m.createdAt.toLocaleString()}
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
                      className="text-[color:var(--color-primary)] underline"
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
