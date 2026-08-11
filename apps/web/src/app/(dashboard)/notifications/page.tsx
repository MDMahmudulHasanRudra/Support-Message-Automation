import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { Badge, type BadgeColor, EmptyState, PageHeader, Table, Td, Th, Tooltip } from "@/components/ui";
import { TestNotificationForm } from "./TestNotificationForm";
import { RetryNotificationButton } from "./RetryNotificationButton";

export default async function NotificationsPage() {
  await requireSession();
  const notifications = await prisma.notification.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return (
    <div>
      <PageHeader title="Notifications" description="Delivery status for Teams and WhatsApp support-group alerts." />

      <TestNotificationForm />

      {notifications.length === 0 ? (
        <EmptyState>No notifications yet.</EmptyState>
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
                  {n.createdAt.toLocaleString()}
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
                <Td>{n.status === "FAILED" ? <RetryNotificationButton id={n.id} /> : null}</Td>
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
  return "yellow";
}
