import { requireAccess } from "@/server/authorize";
import { clientOptions, getLead, orderableProducts } from "@/server/commerce";
import { ButtonLink, Card, PageHeader } from "@/components/ui";
import { OrderForm } from "../OrderForm";

export const metadata = { title: "New order" };

/** A new draft order. `?lead=<id>` starts it from a sales lead, which is marked won when the order is created. */
export default async function NewOrderPage({ searchParams }: { searchParams: Promise<{ lead?: string }> }) {
  await requireAccess("orders.manage");
  const { lead: leadId } = await searchParams;
  const [products, clients, lead] = await Promise.all([orderableProducts(), clientOptions(), leadId ? getLead(leadId).catch(() => null) : null]);
  return (
    <div>
      <PageHeader
        title="New order"
        description={lead ? `From the lead ${lead.name}. Creating the order marks the lead won.` : "Saved as a draft. Nothing leaves stock until you confirm it."}
        actions={<ButtonLink href="/commerce/orders">Back to orders</ButtonLink>}
      />
      <Card>
        <OrderForm
          products={products}
          clients={clients}
          leadId={lead?.id}
          defaults={lead ? { customerName: lead.name, customerPhone: lead.phone ?? "", customerEmail: lead.email ?? "", clientId: lead.clientId ?? "", channel: lead.source === "REFERRAL" ? "OTHER" : lead.source } : undefined}
        />
      </Card>
    </div>
  );
}
