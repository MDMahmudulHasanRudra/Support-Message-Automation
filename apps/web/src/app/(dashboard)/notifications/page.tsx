import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { Badge, Button, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui";
import { retryNotification } from "@/server/actions/notifications";
import { TestNotificationForm } from "./TestNotificationForm";

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
                <Td>{n.createdAt.toLocaleString()}</Td>
                <Td>{n.type}</Td>
                <Td className="max-w-xs truncate">{n.destination}</Td>
                <Td>
                  <Badge color={n.status === "SENT" ? "green" : n.status === "FAILED" ? "red" : "yellow"}>{n.status}</Badge>
                </Td>
                <Td>{n.attemptCount}</Td>
                <Td className="max-w-xs truncate">{n.failureReason ?? "—"}</Td>
                <Td>
                  {n.status === "FAILED" ? (
                    <form action={retryNotification.bind(null, n.id)}>
                      <Button variant="secondary" type="submit">Retry</Button>
                    </form>
                  ) : null}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
