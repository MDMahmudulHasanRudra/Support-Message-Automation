import Link from "@/components/ProjectLink";
import { SavedViewsBar } from "@/components/SavedViewsBar";
import { loadSavedViews } from "@/server/listSavedViewsReader";
import { sanitizeViewQuery } from "@/lib/listSavedViews";
import { Plus } from "lucide-react";
import { ORDER_PAYMENT_LABELS, ORDER_STATUS_LABELS, ORDER_STATUSES, type OrderPaymentStatus } from "@support-automation/shared";
import { pageAccess } from "@/server/authorize";
import { listOrders } from "@/server/commerce";
import { Badge, ButtonLink, EmptyState, PageHeader, SearchField, Table, Td, Th, ViewOnlyNotice } from "@/components/ui";
import { ORDER_STATUS_COLOR, orderWhen as when, PAYMENT_COLOR } from "./orderStyles";

export const metadata = { title: "Orders" };

export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ search?: string; status?: string }> }) {
  const { canManage, session } = await pageAccess("orders.view", "orders.manage");
  const sp = await searchParams;
  const savedViews = await loadSavedViews("/commerce/orders", session.userId);
  const currentQuery = sanitizeViewQuery("/commerce/orders", sp);
  const status = sp.status && (ORDER_STATUSES as readonly string[]).includes(sp.status) ? sp.status : undefined;
  const { rows, counts } = await listOrders({ q: sp.search, status });
  const all = Object.values(counts).reduce((a, b) => a + b, 0);
  const link = (s?: string) => {
    const q = new URLSearchParams();
    if (sp.search) q.set("search", sp.search);
    if (s) q.set("status", s);
    const str = q.toString();
    return `/commerce/orders${str ? `?${str}` : ""}`;
  };

  return (
    <div>
      <PageHeader
        title="Orders"
        description="Orders your team takes from customers on any channel. Confirming one takes its items out of stock."
        actions={
          canManage ? (
            <ButtonLink href="/commerce/orders/new" variant="primary" size="md">
              <Plus className="size-4" aria-hidden /> New order
            </ButtonLink>
          ) : null
        }
      />
      {canManage ? null : <ViewOnlyNotice />}
      <SavedViewsBar page="/commerce/orders" views={savedViews} currentQuery={currentQuery} canShare={canManage} />

      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
          <Link className={!status ? "font-semibold" : "link"} href={link()}>
            All <span className="tabular text-[color:var(--color-muted-foreground)]">{all}</span>
          </Link>
          {ORDER_STATUSES.map((s) => (
            <Link key={s} className={status === s ? "font-semibold" : "link"} href={link(s)}>
              {ORDER_STATUS_LABELS[s]} <span className="tabular text-[color:var(--color-muted-foreground)]">{counts[s] ?? 0}</span>
            </Link>
          ))}
        </div>
        <SearchField placeholder="Order number, name or phone" defaultValue={sp.search ?? ""} preserve={{ status }} />
      </div>

      {rows.length === 0 ? (
        <EmptyState>{sp.search || status ? "No order matches." : "No orders yet."}</EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Order</Th>
              <Th>Customer</Th>
              <Th>Items</Th>
              <Th>Total</Th>
              <Th>Status</Th>
              <Th>Payment</Th>
              <Th>Created</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.id}>
                <Td>
                  <Link className="link font-[family-name:var(--font-mono)] text-xs font-medium" href={`/commerce/orders/${o.id}`}>
                    {o.number}
                  </Link>
                </Td>
                <Td>
                  {o.customerName}
                  {o.customerPhone ? <span className="block text-xs text-[color:var(--color-muted-foreground)]">{o.customerPhone}</span> : null}
                </Td>
                <Td className="tabular">{o.itemCount}</Td>
                <Td className="tabular">{o.total}</Td>
                <Td>
                  <Badge color={ORDER_STATUS_COLOR[o.status]} dot>
                    {ORDER_STATUS_LABELS[o.status]}
                  </Badge>
                </Td>
                <Td>
                  <Badge color={PAYMENT_COLOR[o.paymentStatus as OrderPaymentStatus] ?? "gray"}>{ORDER_PAYMENT_LABELS[o.paymentStatus as OrderPaymentStatus] ?? o.paymentStatus}</Badge>
                </Td>
                <Td className="whitespace-nowrap text-xs">{when(o.createdAt)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
