import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { Badge, Card, PageHeader, Table, Td, Th } from "@/components/ui";

export default async function OverviewPage() {
  await requireSession();

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [
    accounts,
    activeRuleCount,
    messagesLast24h,
    supportRequiredLast24h,
    pendingOutbound,
    recentMessages,
  ] = await Promise.all([
    prisma.whatsAppAccount.findMany({ select: { id: true, label: true, status: true } }),
    prisma.automationRule.count({ where: { status: "ACTIVE" } }),
    prisma.message.count({ where: { direction: "INCOMING", createdAt: { gte: since24h } } }),
    prisma.automationExecution.count({ where: { decision: "SUPPORT_REQUIRED", createdAt: { gte: since24h } } }),
    prisma.outboundMessage.count({ where: { status: { in: ["PENDING", "PROCESSING"] } } }),
    prisma.message.findMany({
      orderBy: { timestampWa: "desc" },
      take: 10,
      select: { id: true, senderPhone: true, body: true, direction: true, processingStatus: true, timestampWa: true },
    }),
  ]);

  return (
    <div>
      <PageHeader title="Overview" description="Live snapshot of the automation system." />

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Card>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">Incoming messages (24h)</p>
          <p className="mt-1 text-2xl font-semibold">{messagesLast24h}</p>
        </Card>
        <Card>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">Support required (24h)</p>
          <p className="mt-1 text-2xl font-semibold">{supportRequiredLast24h}</p>
        </Card>
        <Card>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">Active rules</p>
          <p className="mt-1 text-2xl font-semibold">{activeRuleCount}</p>
        </Card>
        <Card>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">Outbound queue (pending)</p>
          <p className="mt-1 text-2xl font-semibold">{pendingOutbound}</p>
        </Card>
      </div>

      <Card className="mb-6">
        <h2 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">WhatsApp Accounts</h2>
        {accounts.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            No accounts yet — the worker creates one automatically on first connect.
          </p>
        ) : (
          <ul className="space-y-2">
            {accounts.map((a) => (
              <li key={a.id} className="flex items-center justify-between text-sm">
                <span>{a.label}</span>
                <Badge color={a.status === "CONNECTED" ? "green" : a.status === "ERROR" ? "red" : "yellow"}>
                  {a.status}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Recent Messages</h2>
        {recentMessages.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No messages yet.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Time</Th>
                <Th>Sender</Th>
                <Th>Direction</Th>
                <Th>Body</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {recentMessages.map((m) => (
                <tr key={m.id}>
                  <Td>{m.timestampWa.toLocaleString()}</Td>
                  <Td>{m.senderPhone}</Td>
                  <Td>{m.direction}</Td>
                  <Td className="max-w-md truncate">{m.body}</Td>
                  <Td>
                    <Badge color={m.processingStatus === "IGNORED" ? "gray" : "blue"}>{m.processingStatus}</Badge>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
