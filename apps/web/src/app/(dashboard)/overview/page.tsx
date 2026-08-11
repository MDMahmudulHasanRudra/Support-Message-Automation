import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { Alert, Badge, Card, PageHeader, SectionHeader, StatTile, Table, Td, Th } from "@/components/ui";
import type { BadgeColor } from "@/components/ui";

const ACCOUNT_STATUS_COLOR: Record<string, BadgeColor> = {
  CONNECTED: "green",
  ERROR: "red",
  SESSION_ERROR: "red",
  RATE_LIMITED: "red",
  RECONNECTING: "yellow",
  DISCONNECTED: "yellow",
  AUTHENTICATION_REQUIRED: "yellow",
  OUTBOUND_PAUSED: "yellow",
};

function since(hoursAgo: number, nowMs: number): Date {
  return new Date(nowMs - hoursAgo * 60 * 60 * 1000);
}

export default async function OverviewPage() {
  await requireSession();

  // eslint-disable-next-line react-hooks/purity -- server component runs fresh per request; not subject to render-purity rules
  const since24h = since(24, Date.now());

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
      select: {
        id: true,
        senderPhone: true,
        body: true,
        direction: true,
        processingStatus: true,
        timestampWa: true,
      },
    }),
  ]);

  const connectedCount = accounts.filter((a) => a.status === "CONNECTED").length;
  const disconnectedAccounts = accounts.filter((a) => a.status !== "CONNECTED");

  return (
    <div>
      <PageHeader title="Overview" description="Live snapshot of the automation system." />

      {disconnectedAccounts.length > 0 ? (
        <div className="mb-6">
          <Alert tone="warning" title={`${disconnectedAccounts.length} account(s) not connected`}>
            {disconnectedAccounts.map((a) => a.label).join(", ")} — check WhatsApp Accounts for details.
          </Alert>
        </div>
      ) : null}

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-5">
        <StatTile
          label="Connected accounts"
          value={`${connectedCount}/${accounts.length}`}
          tone={connectedCount === accounts.length && accounts.length > 0 ? "success" : "warning"}
        />
        <StatTile label="Incoming messages (24h)" value={messagesLast24h} />
        <StatTile
          label="Support required (24h)"
          value={supportRequiredLast24h}
          tone={supportRequiredLast24h > 0 ? "warning" : "neutral"}
        />
        <StatTile label="Active rules" value={activeRuleCount} />
        <StatTile
          label="Outbound queue (pending)"
          value={pendingOutbound}
          tone={pendingOutbound > 0 ? "warning" : "neutral"}
        />
      </div>

      <Card className="mb-6">
        <SectionHeader title="WhatsApp Accounts" />
        {accounts.length === 0 ? (
          <p className="text-sm text-[color:var(--color-muted-foreground)]">
            No accounts yet — the worker creates one automatically on first connect.
          </p>
        ) : (
          <ul className="space-y-2">
            {accounts.map((a) => (
              <li key={a.id} className="flex items-center justify-between text-sm">
                <span className="text-[color:var(--color-foreground)]">{a.label}</span>
                <Badge color={ACCOUNT_STATUS_COLOR[a.status] ?? "gray"} dot>
                  {a.status}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <SectionHeader title="Recent Messages" />
        {recentMessages.length === 0 ? (
          <p className="text-sm text-[color:var(--color-muted-foreground)]">No messages yet.</p>
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
                  <Td className="font-[family-name:var(--font-mono)] text-xs whitespace-nowrap">
                    {m.timestampWa.toLocaleString()}
                  </Td>
                  <Td className="font-[family-name:var(--font-mono)] text-xs">{m.senderPhone}</Td>
                  <Td>{m.direction}</Td>
                  <Td className="max-w-md truncate">{m.body}</Td>
                  <Td>
                    <Badge color={m.processingStatus === "IGNORED" ? "gray" : "blue"}>
                      {m.processingStatus}
                    </Badge>
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
