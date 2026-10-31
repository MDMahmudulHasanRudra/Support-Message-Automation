import { notFound } from "next/navigation";
import Link from "@/components/ProjectLink";
import { nextOrderStatuses, ORDER_PAYMENT_LABELS, ORDER_STATUS_LABELS, orderItemsEditable, type OrderPaymentStatus, type OrderStatus } from "@support-automation/shared";
import { fromMinor, type ShopProvider } from "@support-automation/shared";
import { pageAccess } from "@/server/authorize";
import { courierConnections, getOrder } from "@/server/commerce";
import { prisma } from "@/server/db";
import { hasPermission } from "@/server/permissions";
import { activeDisabledFeatures } from "@/server/projectFeatures";
import { Badge, ButtonLink, Card, PageHeader, SectionHeader, Table, Td, Th, ViewOnlyNotice } from "@/components/ui";
import { ORDER_STATUS_COLOR, orderWhen, PAYMENT_COLOR } from "../orderStyles";
import { PaymentPanel, StatusMoves } from "./OrderActions";
import { BookShipmentPanel, ShipmentCard, ShopPushPanel } from "./ShipmentPanels";

export const metadata = { title: "Order" };

const CHANNEL_LABELS: Record<string, string> = { WHATSAPP: "WhatsApp", MESSENGER: "Messenger", INSTAGRAM: "Instagram", TELEGRAM: "Telegram", WEBSITE: "Website", PHONE: "Phone", WALK_IN: "Walk-in", OTHER: "Other" };

function describeEvent(e: { kind: string; fromStatus: string | null; toStatus: string | null; detail: Record<string, unknown> | null }): string {
  const d = e.detail ?? {};
  switch (e.kind) {
    case "CREATED":
      return `Created as a draft (${String(d.items ?? "?")} items, ${String(d.total ?? "")})`;
    case "EDITED":
      return `Draft edited (${String(d.items ?? "?")} items, ${String(d.total ?? "")})`;
    case "STATUS":
      return `${ORDER_STATUS_LABELS[e.fromStatus as OrderStatus] ?? e.fromStatus} → ${ORDER_STATUS_LABELS[e.toStatus as OrderStatus] ?? e.toStatus}${d.stock === "DEDUCT" ? " · taken from stock" : d.stock === "RESTORE" ? " · returned to stock" : ""}${d.note ? ` · ${String(d.note)}` : ""}`;
    case "PAYMENT":
      return `Payment ${String(d.amount ?? "")}${d.method ? ` by ${String(d.method)}` : ""}${d.reference ? ` (${String(d.reference)})` : ""}`;
    case "REFUND":
      return `Marked refunded${d.note ? `: ${String(d.note)}` : ""}`;
    case "IMPORTED":
      return `Imported from ${String(d.source ?? "the shop")} (order ${String(d.shopNumber ?? "?")}, ${String(d.total ?? "")})`;
    case "SYNC":
      return `${String(d.source ?? "Shop")}: ${ORDER_STATUS_LABELS[e.fromStatus as OrderStatus] ?? e.fromStatus} → ${ORDER_STATUS_LABELS[e.toStatus as OrderStatus] ?? e.toStatus}, payment ${String(d.payment ?? "").toLowerCase()}`;
    case "PUSHED":
      return `Sent to ${String(d.shop ?? "the shop")} as ${String(d.shopOrder ?? "?")}`;
    default:
      return e.kind;
  }
}

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { canManage, session } = await pageAccess("orders.view", "orders.manage");
  const { id } = await params;
  const order = await getOrder(id);
  if (!order) notFound();
  const payment = order.paymentStatus as OrderPaymentStatus;
  const disabled = await activeDisabledFeatures();
  const courierOn = !disabled.has("COURIER");
  const canShip = courierOn && (await hasPermission(session, "shipments.manage"));
  const couriers = courierOn ? (await courierConnections()).filter((c) => c.isActive) : [];
  const liveShipment = order.shipments.some((s) => s.status !== "FAILED" && s.status !== "CANCELLED");
  const shopProviders: ShopProvider[] = [];
  if (!order.externalSource && (order.status === "CONFIRMED" || order.status === "PROCESSING")) {
    const shops = await prisma.shopConnection.findMany({ where: { isActive: true }, select: { provider: true } });
    for (const { provider } of shops) {
      const key = provider === "WOOCOMMERCE" ? "woocommerce.manage" : "shopify.manage";
      if (!disabled.has(provider) && (await hasPermission(session, key))) shopProviders.push(provider);
    }
  }

  return (
    <div>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            {order.number}
            <Badge color={ORDER_STATUS_COLOR[order.status]} dot>
              {ORDER_STATUS_LABELS[order.status]}
            </Badge>
            <Badge color={PAYMENT_COLOR[payment] ?? "gray"}>{ORDER_PAYMENT_LABELS[payment] ?? payment}</Badge>
          </span>
        }
        description={`Created ${orderWhen(order.createdAt)} by ${order.createdByUsername}.${order.externalSource ? ` Imported from ${order.externalSource === "SHOPIFY" ? "Shopify" : "WooCommerce"}: its items and stock are the shop's.` : ""}`}
        actions={
          <>
            {canManage && orderItemsEditable(order.status) && !order.externalSource ? (
              <ButtonLink href={`/commerce/orders/${order.id}/edit`} variant="primary" size="md">
                Edit draft
              </ButtonLink>
            ) : null}
            <ButtonLink href="/commerce/orders">All orders</ButtonLink>
          </>
        }
      />
      {canManage ? null : <ViewOnlyNotice />}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[3fr_2fr]">
        <div className="space-y-6">
          <Card>
            <SectionHeader title="Items" />
            <Table>
              <thead>
                <tr>
                  <Th>Item</Th>
                  <Th>Qty</Th>
                  <Th>Unit price</Th>
                  <Th>Total</Th>
                </tr>
              </thead>
              <tbody>
                {order.items.map((i) => (
                  <tr key={i.id}>
                    <Td>
                      {i.productId ? (
                        <Link className="link" href={`/commerce/products/${i.productId}`}>
                          {i.name}
                        </Link>
                      ) : (
                        i.name
                      )}
                      {i.sku ? <span className="block font-[family-name:var(--font-mono)] text-xs text-[color:var(--color-muted-foreground)]">{i.sku}</span> : null}
                    </Td>
                    <Td className="tabular">{i.quantity}</Td>
                    <Td className="tabular">{i.unitPrice}</Td>
                    <Td className="tabular">{i.total}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <dl className="ml-auto mt-4 grid max-w-xs grid-cols-2 gap-y-1 text-sm">
              <dt className="text-[color:var(--color-muted-foreground)]">Items</dt>
              <dd className="tabular text-right">{order.subtotal}</dd>
              <dt className="text-[color:var(--color-muted-foreground)]">Discount</dt>
              <dd className="tabular text-right">− {order.discount}</dd>
              <dt className="text-[color:var(--color-muted-foreground)]">Shipping</dt>
              <dd className="tabular text-right">{order.shipping}</dd>
              <dt className="font-semibold">Total</dt>
              <dd className="tabular text-right font-semibold">{order.total}</dd>
              <dt className="text-[color:var(--color-muted-foreground)]">Paid</dt>
              <dd className="tabular text-right">{order.paid}</dd>
              <dt className="text-[color:var(--color-muted-foreground)]">Due</dt>
              <dd className="tabular text-right">{order.due}</dd>
            </dl>
          </Card>

          {canManage ? (
            <Card>
              <SectionHeader title="Status" />
              <StatusMoves orderId={order.id} next={[...nextOrderStatuses(order.status)]} />
            </Card>
          ) : null}

          {courierOn && (order.shipments.length > 0 || (canShip && !liveShipment && (order.status === "CONFIRMED" || order.status === "PROCESSING"))) ? (
            <Card>
              <SectionHeader title="Delivery" description="Booked with a courier from here; the status is read back by itself every half hour." />
              <div className="space-y-3">
                {order.shipments.map((s) => (
                  <ShipmentCard key={s.id} shipment={s} canManage={canShip} />
                ))}
                {canShip && !liveShipment && (order.status === "CONFIRMED" || order.status === "PROCESSING") ? (
                  <BookShipmentPanel
                    orderId={order.id}
                    connections={couriers.map((c) => ({ id: c.id, provider: c.provider, label: c.label, sandbox: c.sandbox }))}
                    defaults={{ name: order.customerName, phone: order.customerPhone ?? "", address: order.shippingAddress ?? "", cod: fromMinor(BigInt(order.dueMinor)) }}
                  />
                ) : null}
              </div>
            </Card>
          ) : null}

          {shopProviders.length > 0 || order.pushes.length > 0 ? (
            <Card>
              <SectionHeader title="Shop" description="Send this order to your online shop. It is sent once; the shop then handles it." />
              <ShopPushPanel orderId={order.id} providers={shopProviders} pushes={order.pushes} />
            </Card>
          ) : null}

          {canManage && order.status !== "CANCELLED" ? (
            <Card>
              <SectionHeader title="Payment" description="Record money as it is received. Payments are kept in the order's history." />
              <PaymentPanel orderId={order.id} due={order.due} paid={payment === "PAID" || payment === "REFUNDED"} canRefund={payment === "PAID" || payment === "PARTIAL"} />
            </Card>
          ) : null}
        </div>

        <div className="space-y-6">
          <Card>
            <SectionHeader title="Customer" />
            <dl className="space-y-2 text-sm">
              <div>
                <dt className="text-xs text-[color:var(--color-muted-foreground)]">Name</dt>
                <dd>{order.customerName}</dd>
              </div>
              {order.customerPhone ? (
                <div>
                  <dt className="text-xs text-[color:var(--color-muted-foreground)]">Phone</dt>
                  <dd>{order.customerPhone}</dd>
                </div>
              ) : null}
              {order.customerEmail ? (
                <div>
                  <dt className="text-xs text-[color:var(--color-muted-foreground)]">Email</dt>
                  <dd>{order.customerEmail}</dd>
                </div>
              ) : null}
              {order.shippingAddress ? (
                <div>
                  <dt className="text-xs text-[color:var(--color-muted-foreground)]">Ship to</dt>
                  <dd className="whitespace-pre-wrap">{order.shippingAddress}</dd>
                </div>
              ) : null}
              {order.channel ? (
                <div>
                  <dt className="text-xs text-[color:var(--color-muted-foreground)]">Came from</dt>
                  <dd>{CHANNEL_LABELS[order.channel] ?? order.channel}</dd>
                </div>
              ) : null}
              {order.client ? (
                <div>
                  <dt className="text-xs text-[color:var(--color-muted-foreground)]">Client record</dt>
                  <dd>
                    <Link className="link" href={`/clients/${order.client.id}`}>
                      {order.client.name} ({order.client.code})
                    </Link>
                  </dd>
                </div>
              ) : null}
            </dl>
            {order.notes ? <p className="mt-4 whitespace-pre-wrap rounded-[var(--radius-md)] bg-[var(--color-neutral-bg)] p-3 text-sm">{order.notes}</p> : null}
          </Card>

          <Card>
            <SectionHeader title="History" description="Every change to this order, newest first. It cannot be edited." />
            <ol className="space-y-3 text-sm">
              {order.events.map((e) => (
                <li key={e.id} className="border-l-2 border-[var(--color-border)] pl-3">
                  <p>{describeEvent(e)}</p>
                  <p className="text-xs text-[color:var(--color-muted-foreground)]">
                    {orderWhen(e.createdAt)} · {e.actorUsername}
                  </p>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
    </div>
  );
}
