import { Alert, Badge, Card, EmptyState, PageHeader, SectionHeader, Table, Td, Th } from "@/components/ui";
import { requireAccess } from "@/server/authorize";
import { requireActiveProject } from "@/server/projectContext";
import { customerForProject, getBillingSettings, getCustomerBilling } from "@/server/saasBilling";
import {
  BILLING_INTERVAL_LABELS,
  billingNotice,
  formatMoneyMinor,
  isBillingInterval,
  isSaasPaymentMethod,
  SAAS_PAYMENT_METHOD_LABELS,
  SAAS_SUBSCRIPTION_STATE_LABELS,
  PROJECT_FEATURES,
} from "@support-automation/shared";

export const metadata = { title: "Subscription" };

const day = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 10) : "—");
const STATE_COLOR = { TRIALING: "blue", ACTIVE: "green", PAST_DUE: "yellow", SUSPENDED: "red", CANCELLED: "gray" } as const;

/**
 * The customer owner's view of their own subscription (SAAS_PLATFORM_PLAN.md section 10.5): plan,
 * renewal date, status, invoices and payments, and how to pay. Read-only — renewals are recorded
 * by the platform. The Lead's page (project_members.manage), never another customer's: the data is
 * looked up from THIS project's customer only.
 */
export default async function SubscriptionPage() {
  await requireAccess("project_members.manage");
  const project = await requireActiveProject();
  const customer = await customerForProject(project.id);
  if (!customer) {
    return (
      <div>
        <PageHeader title="Subscription" description="This workspace's plan and billing." />
        <EmptyState>This workspace has no subscription. Nothing about it is limited or billed here.</EmptyState>
      </div>
    );
  }
  const [{ subscription, invoices, payments }, settings] = await Promise.all([getCustomerBilling(customer.id), getBillingSettings()]);
  const now = new Date();

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader title="Subscription" description={`${customer.name}'s plan, renewal and payments.`} />
      {!subscription ? (
        <EmptyState>No plan has been set up for this workspace yet.</EmptyState>
      ) : (
        <>
          {(() => {
            const notice = billingNotice(
              {
                ...subscription.reading,
                accessUntil: subscription.reading.accessUntil ? new Date(subscription.reading.accessUntil) : null,
                suspendsAt: subscription.reading.suspendsAt ? new Date(subscription.reading.suspendsAt) : null,
              },
              now,
              Math.max(...settings.reminderDaysBefore, 0),
            );
            return notice ? (
              <Alert tone={notice.tone} title={notice.title}>
                {notice.message}
              </Alert>
            ) : null;
          })()}
          <Card>
            <SectionHeader title="Plan" />
            <dl className="grid gap-4 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-[color:var(--color-muted-foreground)]">Plan</dt>
                <dd className="mt-1 font-medium">{subscription.planName}</dd>
              </div>
              <div>
                <dt className="text-xs text-[color:var(--color-muted-foreground)]">Status</dt>
                <dd className="mt-1">
                  <Badge color={STATE_COLOR[subscription.reading.state]} dot>
                    {SAAS_SUBSCRIPTION_STATE_LABELS[subscription.reading.state]}
                  </Badge>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-[color:var(--color-muted-foreground)]">Price</dt>
                <dd className="mt-1">
                  {formatMoneyMinor(subscription.priceMinor, subscription.currency)} /{" "}
                  {isBillingInterval(subscription.interval) ? BILLING_INTERVAL_LABELS[subscription.interval].toLowerCase() : subscription.interval}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-[color:var(--color-muted-foreground)]">{subscription.reading.state === "TRIALING" ? "Trial ends" : "Paid through"}</dt>
                <dd className="mt-1">{day(subscription.reading.accessUntil)}</dd>
              </div>
              <div>
                <dt className="text-xs text-[color:var(--color-muted-foreground)]">WhatsApp numbers</dt>
                <dd className="mt-1">{subscription.maxWhatsAppAccounts ?? "No limit"}</dd>
              </div>
              <div>
                <dt className="text-xs text-[color:var(--color-muted-foreground)]">Users</dt>
                <dd className="mt-1">{subscription.maxUsers ?? "No limit"}</dd>
              </div>
            </dl>
            {subscription.features.length > 0 ? (
              <p className="mt-4 text-xs text-[color:var(--color-muted-foreground)]">
                Includes: {PROJECT_FEATURES.filter((f) => subscription.features.includes(f.key)).map((f) => f.label).join(", ")}
              </p>
            ) : null}
          </Card>

          {settings.paymentInstructions ? (
            <Card>
              <SectionHeader title="How to pay" />
              <p className="whitespace-pre-line text-sm">{settings.paymentInstructions}</p>
            </Card>
          ) : null}

          <Card>
            <SectionHeader title="Invoices" />
            {invoices.length === 0 ? (
              <p className="text-sm text-[color:var(--color-muted-foreground)]">No invoices yet.</p>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Invoice</Th>
                    <Th>Period</Th>
                    <Th>Amount</Th>
                    <Th>Status</Th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((i) => (
                    <tr key={i.id}>
                      <Td className="font-mono text-xs">{i.number}</Td>
                      <Td>
                        {day(i.periodStart)} → {day(i.periodEnd)}
                      </Td>
                      <Td>{formatMoneyMinor(i.amountMinor, i.currency)}</Td>
                      <Td>
                        <Badge color={i.status === "PAID" ? "green" : i.status === "OPEN" ? "yellow" : "gray"}>{i.status === "OPEN" ? "Due" : i.status === "PAID" ? "Paid" : "Void"}</Badge>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          <Card>
            <SectionHeader title="Payments" />
            {payments.length === 0 ? (
              <p className="text-sm text-[color:var(--color-muted-foreground)]">No payments recorded yet.</p>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Date</Th>
                    <Th>Amount</Th>
                    <Th>Method</Th>
                    <Th>Invoice</Th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p) => (
                    <tr key={p.id} className={p.reversedAt ? "opacity-60" : ""}>
                      <Td>{day(p.receivedAt)}</Td>
                      <Td>
                        {formatMoneyMinor(p.amountMinor, p.currency)}
                        {p.reversedAt ? <span className="ml-2 text-xs">(reversed)</span> : null}
                      </Td>
                      <Td>{isSaasPaymentMethod(p.method) ? SAAS_PAYMENT_METHOD_LABELS[p.method] : p.method}</Td>
                      <Td className="font-mono text-xs">{p.invoiceNumber ?? "—"}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
