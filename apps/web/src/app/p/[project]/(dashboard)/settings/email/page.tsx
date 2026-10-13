import { EMAIL_STATE_LABELS } from "@support-automation/shared";
import { pageAccess } from "@/server/authorize";
import { getEmailSettingsView, listRecentEmails } from "@/server/emailSettings";
import { formatDateTime } from "@/lib/date";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Alert, Badge, Card, PageHeader, SectionHeader, Table, Td, Th } from "@/components/ui";
import { EmailSettingsForm } from "./EmailSettingsForm";

export const metadata = { title: "Email" };

const STATE_COLOR = { CONNECTED: "green", NOT_CONFIGURED: "gray", NOT_TESTED: "yellow", NEEDS_RETEST: "yellow", TEST_FAILED: "red" } as const;
const STATUS_COLOR: Record<string, "green" | "yellow" | "red" | "gray"> = { ACCEPTED: "green", QUEUED: "yellow", SENDING: "yellow", FAILED: "red", UNKNOWN: "red" };
const STATUS_LABEL: Record<string, string> = { ACCEPTED: "Accepted by the server", QUEUED: "Waiting", SENDING: "Sending", FAILED: "Failed", UNKNOWN: "Outcome unknown" };

/**
 * Settings → Email (CLIENT_CENTER_PLAN.md §3.1): the SMTP connection the project's email will leave
 * from. No provider is assumed and nothing is sent except the test message. The password is never
 * shown. "Accepted" means the mail server took the message, not that anyone received it.
 */
export default async function EmailSettingsPage() {
  await pageAccess("communications.manage_email", "communications.manage_email");
  const [settings, recent] = await Promise.all([getEmailSettingsView(), listRecentEmails()]);
  const inFlight = recent.some((m) => m.status === "QUEUED" || m.status === "SENDING");

  return (
    <div className="space-y-6">
      {inFlight ? <AutoRefresh intervalMs={3000} /> : null}
      <PageHeader title="Email" description="The mail server this project's email is sent through. Enter what your mail provider gave you, then send yourself a test message." />

      <Card className="p-6">
        <div className="flex flex-wrap items-center gap-3">
          <Badge color={STATE_COLOR[settings.state]} dot>
            {EMAIL_STATE_LABELS[settings.state]}
          </Badge>
          {settings.enabled ? <Badge color="green">On</Badge> : <Badge color="gray">Off</Badge>}
        </div>
        {settings.lastTestAt ? (
          <p className="mt-2 text-[13px] text-[color:var(--color-muted-foreground)]">
            Last test: {formatDateTime(settings.lastTestAt)} — {settings.lastTestOk ? "accepted" : "not accepted"}
          </p>
        ) : null}
        {settings.lastTestOk === false && settings.lastTestError ? (
          <div className="mt-3">
            <Alert tone="danger">{settings.lastTestError}</Alert>
          </div>
        ) : null}
        {settings.state === "NOT_CONFIGURED" ? (
          <p className="mt-3 text-[13px] text-[color:var(--color-muted-foreground)]">
            Nothing is configured yet, and no provider is assumed. To use email you need, from your mail provider: the server name, port, username and password; and, in your domain&apos;s DNS, the SPF, DKIM and DMARC records that decide whether mail lands in the inbox or in spam.
          </p>
        ) : null}
      </Card>

      <Card className="p-6">
        <SectionHeader title="Connection" />
        <EmailSettingsForm settings={settings} />
      </Card>

      <Card className="p-6">
        <SectionHeader title="Recent messages" />
        {recent.length === 0 ? (
          <p className="text-sm text-[color:var(--color-muted-foreground)]">Nothing has been sent.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>To</Th>
                <Th>Kind</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {recent.map((m) => (
                <tr key={m.id}>
                  <Td>{formatDateTime(m.createdAt)}</Td>
                  <Td>{m.toAddress}</Td>
                  <Td>{m.purpose === "TEST" ? "Test" : m.purpose}</Td>
                  <Td>
                    <Badge color={STATUS_COLOR[m.status] ?? "gray"}>{STATUS_LABEL[m.status] ?? m.status}</Badge>
                    {m.lastError ? <div className="mt-1 max-w-md text-xs text-[color:var(--color-muted-foreground)]">{m.lastError}</div> : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <p className="mt-3 text-xs text-[color:var(--color-muted-foreground)]">&quot;Accepted&quot; means the mail server took the message. SMTP cannot tell us that it was delivered or read.</p>
      </Card>
    </div>
  );
}
