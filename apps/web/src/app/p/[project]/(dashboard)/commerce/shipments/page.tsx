import Link from "@/components/ProjectLink";
import { SavedViewsBar } from "@/components/SavedViewsBar";
import { loadSavedViews } from "@/server/listSavedViewsReader";
import { sanitizeViewQuery } from "@/lib/listSavedViews";
import { COURIER_LABELS, SHIPMENT_STATUS_LABELS, SHIPMENT_STATUSES, type ShipmentStatus } from "@support-automation/shared";
import { pageAccess } from "@/server/authorize";
import { listShipments } from "@/server/commerce";
import { Badge, ButtonLink, EmptyState, PageHeader, SearchField, Table, Td, Th, ViewOnlyNotice } from "@/components/ui";
import { SHIP_STATUS_COLOR_KEYS } from "../orders/[id]/shipmentLabels";

export const metadata = { title: "Shipments" };

const when = (iso: string | null) => (iso ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso)) : "—");

export default async function ShipmentsPage({ searchParams }: { searchParams: Promise<{ search?: string; status?: string }> }) {
  const { canManage, session } = await pageAccess("shipments.view", "shipments.manage");
  const sp = await searchParams;
  const savedViews = await loadSavedViews("/commerce/shipments", session.userId);
  const currentQuery = sanitizeViewQuery("/commerce/shipments", sp);
  const status = sp.status && (SHIPMENT_STATUSES as readonly string[]).includes(sp.status) ? sp.status : undefined;
  const { rows, counts } = await listShipments({ status, q: sp.search });
  const link = (s?: string) => {
    const q = new URLSearchParams();
    if (sp.search) q.set("search", sp.search);
    if (s) q.set("status", s);
    const str = q.toString();
    return `/commerce/shipments${str ? `?${str}` : ""}`;
  };
  const shown = SHIPMENT_STATUSES.filter((s) => counts[s]);

  return (
    <div>
      <PageHeader
        title="Shipments"
        description="Every parcel booked with a courier. Open ones are checked with the courier every half hour; book new ones from an order."
        actions={<ButtonLink href="/settings/couriers">Couriers</ButtonLink>}
      />
      {canManage ? null : <ViewOnlyNotice />}
      <SavedViewsBar page="/commerce/shipments" views={savedViews} currentQuery={currentQuery} canShare={canManage} />
      {counts.UNKNOWN ? (
        <p className="mb-4 rounded-[var(--radius-md)] bg-[var(--color-warning-bg)] p-3 text-sm text-[color:var(--color-warning-fg)]">
          {counts.UNKNOWN} booking{counts.UNKNOWN === 1 ? "" : "s"} got no answer from the courier. Open each order, check the courier&apos;s panel, and record what you find.
        </p>
      ) : null}
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
          <Link className={!status ? "font-semibold" : "link"} href={link()}>
            All
          </Link>
          {shown.map((s) => (
            <Link key={s} className={status === s ? "font-semibold" : "link"} href={link(s)}>
              {SHIPMENT_STATUS_LABELS[s]} <span className="tabular text-[color:var(--color-muted-foreground)]">{counts[s]}</span>
            </Link>
          ))}
        </div>
        <SearchField placeholder="Reference, consignment, phone or name" defaultValue={sp.search ?? ""} preserve={{ status }} />
      </div>
      {rows.length === 0 ? (
        <EmptyState>No shipments{status || sp.search ? " match" : " yet"}.</EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Order</Th>
              <Th>Courier</Th>
              <Th>Recipient</Th>
              <Th>Collect</Th>
              <Th>Status</Th>
              <Th>Checked</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <Td>
                  <Link className="link font-[family-name:var(--font-mono)] text-xs" href={`/commerce/orders/${s.order.id}`}>
                    {s.order.number}
                  </Link>
                </Td>
                <Td className="text-xs">
                  {COURIER_LABELS[s.provider]}
                  {s.consignmentId ? <span className="block font-[family-name:var(--font-mono)] text-[color:var(--color-muted-foreground)]">#{s.consignmentId}</span> : null}
                </Td>
                <Td>
                  {s.recipientName}
                  <span className="block text-xs text-[color:var(--color-muted-foreground)]">{s.recipientPhone}</span>
                </Td>
                <Td className="tabular">{s.cod}</Td>
                <Td>
                  <Badge color={SHIP_STATUS_COLOR_KEYS[s.status as ShipmentStatus]} dot>
                    {SHIPMENT_STATUS_LABELS[s.status as ShipmentStatus]}
                  </Badge>
                  {s.providerStatus ? <span className="block text-xs text-[color:var(--color-muted-foreground)]">{s.providerStatus}</span> : null}
                  {s.error ? <span className="block text-xs text-[color:var(--color-danger)]">{s.error}</span> : null}
                </Td>
                <Td className="whitespace-nowrap text-xs">{when(s.lastCheckedAt)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
