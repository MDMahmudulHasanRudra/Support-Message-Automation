import { notFound, redirect } from "next/navigation";
import { fromMinor, orderItemsEditable } from "@support-automation/shared";
import { requireAccess } from "@/server/authorize";
import { clientOptions, getOrder, orderableProducts } from "@/server/commerce";
import { projectPath } from "@/server/projectPaths";
import { ButtonLink, Card, PageHeader } from "@/components/ui";
import { OrderForm } from "../../OrderForm";

export const metadata = { title: "Edit order" };

export default async function EditOrderPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAccess("orders.manage");
  const { id } = await params;
  const order = await getOrder(id);
  if (!order) notFound();
  if (!orderItemsEditable(order.status)) redirect(await projectPath(`/commerce/orders/${id}`));
  const [products, clients] = await Promise.all([orderableProducts(), clientOptions()]);
  return (
    <div>
      <PageHeader title={`Edit ${order.number}`} description="A draft can change freely. Once confirmed, its items and prices are settled." actions={<ButtonLink href={`/commerce/orders/${id}`}>Back to order</ButtonLink>} />
      <Card>
        <OrderForm
          orderId={id}
          products={products}
          clients={clients}
          defaults={{
            customerName: order.customerName,
            customerPhone: order.customerPhone ?? "",
            customerEmail: order.customerEmail ?? "",
            shippingAddress: order.shippingAddress ?? "",
            channel: order.channel ?? "",
            clientId: order.client?.id ?? "",
            notes: order.notes ?? "",
            discount: BigInt(order.discountMinor) ? fromMinor(BigInt(order.discountMinor)) : "",
            shipping: BigInt(order.shippingMinor) ? fromMinor(BigInt(order.shippingMinor)) : "",
            lines: order.items.filter((i) => i.productId).map((i) => ({ productId: i.productId!, variantId: i.variantId, quantity: i.quantity, unitPrice: fromMinor(BigInt(i.unitPriceMinor)) })),
          }}
        />
      </Card>
    </div>
  );
}
