import Link from "next/link";
import { prisma } from "@support-automation/db";
import type { OutboundMessageStatus, Prisma } from "@prisma/client";
import { requireSession } from "@/server/auth";
import { Badge, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui";

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
      <PageHeader title="Group Message Sending History" description="Every individual group send from the Group Message Sender, across all jobs." />

      <form className="mb-4 flex flex-wrap gap-2 text-sm" method="GET">
        <select name="accountId" defaultValue={filters.accountId ?? ""} className={inputClass}>
          <option value="">All accounts</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
        <select name="status" defaultValue={filters.status ?? ""} className={inputClass}>
          <option value="">All statuses</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input name="group" placeholder="Group name contains…" defaultValue={filters.group ?? ""} className={inputClass} />
        <input name="from" type="date" defaultValue={filters.from ?? ""} className={inputClass} />
        <input name="to" type="date" defaultValue={filters.to ?? ""} className={inputClass} />
        <button type="submit" className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white dark:bg-zinc-50 dark:text-zinc-900">
          Filter
        </button>
        <Link href="/group-message-sender/history" className="rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700">
          Clear
        </Link>
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
                <Td>{m.createdAt.toLocaleString()}</Td>
                <Td>{m.account.label}</Td>
                <Td>{m.groupNameSnapshot ?? "—"}</Td>
                <Td className="max-w-xs truncate">{m.body}</Td>
                <Td>
                  <Badge color={statusColor(m.status)}>{m.status}</Badge>
                </Td>
                <Td>{m.attemptCount}</Td>
                <Td className="max-w-xs">{m.failureReason ?? "—"}</Td>
                <Td>{m.providerMessageId ?? "—"}</Td>
                <Td>{m.createdBy?.name ?? m.createdBy?.email ?? "—"}</Td>
                <Td>
                  {m.broadcastJobId ? (
                    <Link href={`/group-message-sender/jobs/${m.broadcastJobId}`} className="underline">
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

function statusColor(status: string): "green" | "red" | "yellow" | "gray" | "blue" {
  if (status === "SENT") return "green";
  if (status === "FAILED") return "red";
  if (status === "SKIPPED" || status === "CANCELLED") return "gray";
  if (status === "PROCESSING") return "blue";
  return "yellow";
}

const inputClass = "rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900";
