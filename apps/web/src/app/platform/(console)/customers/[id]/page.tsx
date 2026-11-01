import { notFound } from "next/navigation";
import { Alert, Badge, Card, PageHeader, SectionHeader } from "@/components/ui";
import { requireOperatorPage } from "@/server/platform/auth";
import { getCustomer, getDomainSettings } from "@/server/platform/customers";
import { customerInvitations, customerPeople, getBillingSettings, getCustomerBilling, listPlans } from "@/server/platform/billing";
import { customerHealth } from "@/server/platform/monitoring";
import { listSupportSessions } from "@/server/platform/support";
import { BillingPanel } from "./BillingPanel";
import { OwnerPanel } from "./OwnerPanel";
import { DomainManager } from "../../DomainManager";
import { CustomerDetailsForm } from "./CustomerDetailsForm";
import { CustomerHealthPanel } from "./CustomerHealthPanel";
import { SupportAccessPanel } from "./SupportAccessPanel";
import { CopyText } from "./CopyText";
import { CustomerRemovalPanel, RemovedCustomerPanel } from "./CustomerRemovalPanel";
import { ModuleApprovalsPanel } from "./ModuleApprovalsPanel";
import { listCustomerModuleApprovals } from "@/server/moduleApprovals";
import { APPROVAL_REQUIRED_MODULES, moduleDefinition } from "@support-automation/shared";

export const metadata = { title: "Customer" };

const APPROVAL_TIME = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", dateStyle: "medium", timeStyle: "short" });

export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const operator = await requireOperatorPage();
  const canManage = true;
  const { id } = await params;
  const [customer, settings, billing, plans, billingSettings, invitations, people, health, support, approvals] = await Promise.all([
    getCustomer(id),
    getDomainSettings(),
    getCustomerBilling(id, { events: true }),
    listPlans(),
    getBillingSettings(),
    customerInvitations(id),
    customerPeople(id),
    customerHealth(id),
    listSupportSessions({ customerId: id, take: 10 }),
    listCustomerModuleApprovals(id),
  ]);
  if (!customer) notFound();
  const scheme = (process.env.NEXTAUTH_URL ?? "").startsWith("http://") ? "http" : "https";
  const address = customer.domains.find((d) => d.status === "ACTIVE") ?? customer.domains.find((d) => d.status === "VERIFIED");
  const loginLink = address ? `${scheme}://${address.hostname}/login` : null;
  const when = (iso: string, by: string | null) => `${new Date(iso).toLocaleString()}${by ? ` by ${by}` : ""}`;

  // Deleted permanently: only the record and the platform's own billing history remain (CUSTOMER_REMOVAL.md).
  if (customer.purgedAt) {
    return (
      <div className="max-w-4xl space-y-6">
        <PageHeader title={customer.name} actions={<Badge color="red">Deleted permanently</Badge>} />
        <Alert tone="neutral">
          Deleted permanently {when(customer.purgedAt, customer.purgedByUsername)}. Its workspaces, data, logins and addresses are gone; the invoices and payments below are kept as the platform&apos;s own record.
        </Alert>
        <Card>
          <SectionHeader title="Subscription history" />
          <BillingPanel customerId={customer.id} billing={billing} plans={plans} defaultGraceDays={billingSettings.defaultGraceDays} canManage={false} />
        </Card>
      </div>
    );
  }

  if (customer.removedAt) {
    return (
      <div className="max-w-4xl space-y-6">
        <PageHeader title={customer.name} actions={<Badge color="yellow">Removed</Badge>} />
        <Alert tone="warning">
          Removed {when(customer.removedAt, customer.removedByUsername)}. Its workspaces are archived and its addresses and logins are switched off; all of its data is kept.
        </Alert>
        <Card>
          <SectionHeader title="Restore or delete" description="Both need your platform password." />
          <RemovedCustomerPanel customerId={customer.id} customerName={customer.name} />
        </Card>
        <Card>
          <SectionHeader title="Subscription" description="Not billed or reminded while removed." />
          <BillingPanel customerId={customer.id} billing={billing} plans={plans} defaultGraceDays={billingSettings.defaultGraceDays} canManage={false} />
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader
        title={customer.name}
        description={
          customer.isFounding
            ? "The original installation, adopted as a customer. Its software is exactly as it was."
            : "This customer's own copy of the software: its Main Admin, workspaces, people and settings are theirs alone."
        }
        actions={customer.isFounding ? <Badge color="blue">Original installation</Badge> : null}
      />

      <Card>
        <SectionHeader title="Their software" description="What the customer runs. Their Main Admin manages it from their own address; the platform only sees counts." />
        <dl className="grid gap-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-[color:var(--color-muted-foreground)]">Workspaces</dt>
            <dd className="mt-1 space-y-0.5">
              {customer.projects.length === 0
                ? "None yet"
                : customer.projects.map((p) => (
                    <div key={p.id}>
                      {p.name} <span className="font-mono text-xs text-[color:var(--color-muted-foreground)]">/p/{p.slug}</span>{" "}
                      <span className="text-xs text-[color:var(--color-muted-foreground)]">· {p.status.toLowerCase()} · {p.whatsappNumbers} WhatsApp</span>
                    </div>
                  ))}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-[color:var(--color-muted-foreground)]">People with a login</dt>
            <dd className="mt-1 text-lg font-semibold">{customer.people}</dd>
          </div>
          <div>
            <dt className="text-xs text-[color:var(--color-muted-foreground)]">Login link for the customer</dt>
            <dd className="mt-1">{loginLink ? <CopyText text={loginLink} /> : <span className="text-[color:var(--color-muted-foreground)]">After their address is verified.</span>}</dd>
          </div>
        </dl>
      </Card>

      <Card>
        <SectionHeader title="Health" description="Their WhatsApp numbers, delivery and data collection — counts only, never a conversation." />
        <CustomerHealthPanel health={health} />
      </Card>

      <Card>
        <SectionHeader
          title="Subscription"
          description={customer.isFounding ? "No plan unless you assign one: until then this customer is never billed, limited or suspended." : "Plan, renewal, invoices and payments."}
        />
        <BillingPanel customerId={customer.id} billing={billing} plans={plans} defaultGraceDays={billingSettings.defaultGraceDays} canManage={canManage} />
      </Card>

      <Card>
        <SectionHeader title="Owner and people" description="The owner is the customer's own Main Admin: they run their software, its projects, users and roles. They can never reach the platform." />
        <OwnerPanel customerId={customer.id} people={people} invitations={invitations} canManage={canManage} />
      </Card>

      <Card>
        <SectionHeader
          title="Approval-only modules"
          description="WhatsApp profile pictures, Smart Bulk Import and Social Studio are never part of a plan. Approve them here; the customer's Main Admin then decides whether to switch them on."
        />
        <ModuleApprovalsPanel
          customerId={customer.id}
          modules={APPROVAL_REQUIRED_MODULES.map((key) => ({ key, name: moduleDefinition(key)?.name ?? key }))}
          projects={customer.projects.map((p) => ({ id: p.id, name: p.name }))}
          approvals={approvals.map((a) => ({
            id: a.id,
            moduleName: a.moduleName,
            scope: a.targetProjectId ? `${a.targetProjectName ?? "a workspace"} only` : "Every workspace",
            reason: a.reason,
            approved: `${APPROVAL_TIME.format(a.approvedAt)} by ${a.approvedByUsername}`,
            revoked: a.revokedAt ? `${APPROVAL_TIME.format(a.revokedAt)} by ${a.revokedByUsername ?? "?"}` : null,
            revokeReason: a.revokeReason,
          }))}
        />
      </Card>

      <Card>
        <SectionHeader
          title="Support access"
          description="Enter this customer's software for technical support — time-limited, with a reason, recorded, visible to the customer and revocable. Never their password."
        />
        {address ? (
          <SupportAccessPanel customerId={customer.id} canSupport={operator.canSupport} sessions={support} />
        ) : (
          <Alert tone="info">Available once the customer&apos;s address is verified: support access opens on their own address.</Alert>
        )}
      </Card>

      <Card>
        <SectionHeader
          title="Addresses"
          description={
            settings.hostRoutingEnabled
              ? "A live address opens this customer's software and nothing else."
              : "Hostname routing is off (Domains), so addresses are prepared and checked but every hostname still behaves as before."
          }
        />
        <DomainManager customerId={customer.id} domains={customer.domains} canManage={canManage} rootDomain={settings.rootDomain} />
      </Card>

      <Card>
        <SectionHeader title="Details" />
        <CustomerDetailsForm
          customerId={customer.id}
          canManage={canManage}
          initial={{ name: customer.name, contactName: customer.contactName, contactEmail: customer.contactEmail, contactPhone: customer.contactPhone, notes: customer.notes }}
        />
        <p className="mt-4 text-xs text-[color:var(--color-muted-foreground)]">
          Added {new Date(customer.createdAt).toLocaleDateString()}
          {customer.createdByUsername ? ` by ${customer.createdByUsername}` : ""}.
        </p>
      </Card>

      {customer.isFounding ? null : (
        <Card>
          <SectionHeader
            title="Remove or delete this customer"
            description="Choose what happens. Both need the customer's name typed and your platform password, and both are recorded on the platform's Activity page."
          />
          <CustomerRemovalPanel customerId={customer.id} customerName={customer.name} />
        </Card>
      )}
    </div>
  );
}
