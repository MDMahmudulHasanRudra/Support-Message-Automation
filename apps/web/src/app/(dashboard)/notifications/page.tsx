/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { Badge, type BadgeColor, EmptyState, HelpButton, HelpSection, PageHeader, Table, Td, Th, Tooltip } from "@/components/ui";
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
      <PageHeader
        title="Notifications"
        description="Delivery status for Teams and WhatsApp support-group alerts."
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
                <Td>{n.status === "FAILED" ? <RetryNotificationButton id={n.id} /> : "—"}</Td>
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
