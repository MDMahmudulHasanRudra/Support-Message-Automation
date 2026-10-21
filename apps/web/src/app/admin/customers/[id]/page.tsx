import NextLink from "next/link";
import { notFound } from "next/navigation";
import { Alert, Card, PageHeader, SectionHeader } from "@/components/ui";
import { requireMainAdminPage } from "@/server/mainAdmin";
import { getCustomer, getDomainSettings } from "@/server/saasAdmin";
import { DomainManager } from "../../DomainManager";
import { CustomerDetailsForm } from "./CustomerDetailsForm";

export const metadata = { title: "Customer" };

export default async function CustomerPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ created?: string }> }) {
  const { canManage } = await requireMainAdminPage();
  const [{ id }, { created }] = await Promise.all([params, searchParams]);
  const [customer, settings] = await Promise.all([getCustomer(id), getDomainSettings()]);
  if (!customer) notFound();

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title={customer.name} description="The customer's workspace, its addresses and its contact details." />
      {created ? <Alert tone="success">Customer added. Next: create the DNS record for its address and press Check now.</Alert> : null}

      <Card>
        <SectionHeader title="Workspace" />
        {customer.project ? (
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <div>
              <NextLink href={`/admin/projects/${customer.project.id}`} className="font-medium hover:underline">
                {customer.project.name}
              </NextLink>{" "}
              <span className="font-mono text-xs text-[color:var(--color-muted-foreground)]">/p/{customer.project.slug}</span>
              <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
                {customer.project.status.toLowerCase()} · {customer.project.whatsappNumbers} WhatsApp number{customer.project.whatsappNumbers === 1 ? "" : "s"} ·{" "}
                {customer.project.people} {customer.project.people === 1 ? "person" : "people"} with access
              </p>
            </div>
            <NextLink href={`/admin/projects/${customer.project.id}`} className="text-[13px] font-medium text-[color:var(--color-accent)] hover:underline">
              Manage people and features →
            </NextLink>
          </div>
        ) : (
          <p className="text-sm text-[color:var(--color-muted-foreground)]">No workspace is attached.</p>
        )}
      </Card>

      <Card>
        <SectionHeader
          title="Addresses"
          description={
            settings.hostRoutingEnabled
              ? "A live address opens this customer's workspace and nothing else."
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
    </div>
  );
}
