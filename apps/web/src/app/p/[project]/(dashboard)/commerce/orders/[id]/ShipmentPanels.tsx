"use client";

import { useEffect, useState, useTransition } from "react";
import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { COURIER_LABELS, SHIP_STATUS_COLOR_KEYS, SHIPMENT_STATUS_LABELS, SHOP_LABELS, type CourierProvider, type ShipmentStatus, type ShopProvider } from "./shipmentLabels";
import { Alert, Badge, Button, Field, Input, Select, Textarea, useToast } from "@/components/ui";
import { bookOrderShipment, refreshOrderShipment, resolveShipment, searchCourierAreas } from "@/server/actions/couriers";
import { pushOrderToShop, resolveShopPush } from "@/server/actions/shops";

function useRun() {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<{ error?: string; success?: string }>, after?: () => void) => {
    setError(null);
    startTransition(async () => {
      const r = await fn();
      if (r.error) setError(r.error);
      else {
        showToast({ tone: "success", title: r.success ?? "Done" });
        after?.();
      }
      router.refresh();
    });
  };
  return { pending, error, run };
}

/** Book this order with one of the project's couriers. */
export function BookShipmentPanel({
  orderId,
  connections,
  defaults,
}: {
  orderId: string;
  connections: Array<{ id: string; provider: CourierProvider; label: string; sandbox: boolean }>;
  defaults: { name: string; phone: string; address: string; cod: string };
}) {
  const { pending, error, run } = useRun();
  const [form, setForm] = useState({ connectionId: connections[0]?.id ?? "", recipientName: defaults.name, recipientPhone: defaults.phone, recipientAddress: defaults.address, cod: defaults.cod, note: "", areaId: "", areaName: "" });
  const provider = connections.find((c) => c.id === form.connectionId)?.provider;
  const [areaQuery, setAreaQuery] = useState("");
  const [areas, setAreas] = useState<Array<{ id: string; name: string; district: string | null }>>([]);
  const [areaError, setAreaError] = useState<string | null>(null);

  useEffect(() => {
    if (provider !== "REDX") return;
    const handle = setTimeout(async () => {
      const r = await searchCourierAreas(form.connectionId, areaQuery);
      setAreas(r.areas);
      setAreaError(r.error ?? null);
    }, 300);
    return () => clearTimeout(handle);
  }, [provider, form.connectionId, areaQuery]);

  if (connections.length === 0) return <p className="text-sm text-[color:var(--color-muted-foreground)]">No courier is connected. Connect one under Settings → Couriers.</p>;
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => bookOrderShipment(orderId, form));
      }}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Courier">
          <Select value={form.connectionId} onChange={(e) => setForm({ ...form, connectionId: e.target.value, areaId: "", areaName: "" })}>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
                {c.sandbox ? " (sandbox)" : ""}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Amount to collect" hint="Cash on delivery. 0 if already paid.">
          <Input value={form.cod} onChange={(e) => setForm({ ...form, cod: e.target.value })} inputMode="decimal" />
        </Field>
        <Field label="Recipient">
          <Input value={form.recipientName} onChange={(e) => setForm({ ...form, recipientName: e.target.value })} maxLength={100} required />
        </Field>
        <Field label="Mobile number" hint="01XXXXXXXXX">
          <Input value={form.recipientPhone} onChange={(e) => setForm({ ...form, recipientPhone: e.target.value })} inputMode="tel" required />
        </Field>
        <Field label="Delivery address" className="sm:col-span-2">
          <Textarea value={form.recipientAddress} onChange={(e) => setForm({ ...form, recipientAddress: e.target.value })} rows={2} maxLength={250} required className="min-h-0" />
        </Field>
        {provider === "REDX" ? (
          <Field label="Delivery area" className="sm:col-span-2" error={areaError ?? undefined} hint={form.areaName ? `Chosen: ${form.areaName}` : "Search and choose the area."}>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input value={areaQuery} onChange={(e) => setAreaQuery(e.target.value)} placeholder="Search areas" />
              <Select
                value={form.areaId}
                onChange={(e) => {
                  const a = areas.find((x) => x.id === e.target.value);
                  setForm({ ...form, areaId: a?.id ?? "", areaName: a?.name ?? "" });
                }}
              >
                <option value="">Choose…</option>
                {areas.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.district ? ` — ${a.district}` : ""}
                  </option>
                ))}
              </Select>
            </div>
          </Field>
        ) : null}
        <Field label="Note for the courier" className="sm:col-span-2">
          <Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} maxLength={250} />
        </Field>
      </div>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Button type="submit" loading={pending}>
        Book with {provider ? COURIER_LABELS[provider] : "courier"}
      </Button>
    </form>
  );
}

export interface ShipmentView {
  id: string;
  provider: CourierProvider;
  status: ShipmentStatus;
  providerStatus: string | null;
  invoice: string;
  consignmentId: string | null;
  cod: string;
  error: string | null;
  lastCheckedAt: string | null;
  events: Array<{ id: string; status: string; providerStatus: string | null; note: string | null; actorUsername: string | null; createdAt: string }>;
}

const when = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

/** One shipment on the order: status, refresh, and recording what the courier's panel shows. */
export function ShipmentCard({ shipment, canManage }: { shipment: ShipmentView; canManage: boolean }) {
  const { pending, error, run } = useRun();
  const [reference, setReference] = useState("");
  const open = !["DELIVERED", "PARTIAL_DELIVERED", "RETURNED", "CANCELLED", "FAILED"].includes(shipment.status);
  return (
    <div className="space-y-2 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">
          {COURIER_LABELS[shipment.provider]} {shipment.consignmentId ? <span className="font-[family-name:var(--font-mono)] text-xs">#{shipment.consignmentId}</span> : null}
        </span>
        <Badge color={SHIP_STATUS_COLOR_KEYS[shipment.status]} dot>
          {SHIPMENT_STATUS_LABELS[shipment.status]}
        </Badge>
      </div>
      <p className="text-xs text-[color:var(--color-muted-foreground)]">
        Reference {shipment.invoice} · collect {shipment.cod}
        {shipment.providerStatus ? ` · courier says “${shipment.providerStatus}”` : ""}
        {shipment.lastCheckedAt ? ` · checked ${when(shipment.lastCheckedAt)}` : ""}
      </p>
      {shipment.error ? <p className="text-xs text-[color:var(--color-danger)]">{shipment.error}</p> : null}
      {canManage ? (
        <div className="flex flex-wrap items-end gap-2">
          {open && shipment.status !== "UNKNOWN" && shipment.status !== "BOOKING" ? (
            <Button size="sm" variant="secondary" loading={pending} onClick={() => run(() => refreshOrderShipment(shipment.id))}>
              Check status now
            </Button>
          ) : null}
          {shipment.status === "UNKNOWN" ? (
            <>
              <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Consignment id from the courier" className="w-56" />
              <Button size="sm" loading={pending} onClick={() => run(() => resolveShipment(shipment.id, "BOOKED", reference, ""))}>
                It was booked
              </Button>
              <Button size="sm" variant="secondary" loading={pending} onClick={() => run(() => resolveShipment(shipment.id, "FAILED", "", "Not found in the courier's panel"))}>
                It was not booked
              </Button>
            </>
          ) : null}
          {open && shipment.status !== "UNKNOWN" && shipment.status !== "BOOKING" ? (
            <Button size="sm" variant="ghost" loading={pending} onClick={() => run(() => resolveShipment(shipment.id, "CANCELLED", "", "Cancelled in the courier's panel"))}>
              Mark cancelled at courier
            </Button>
          ) : null}
        </div>
      ) : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {shipment.events.length ? (
        <ol className="space-y-1 border-t border-[var(--color-border)] pt-2 text-xs text-[color:var(--color-muted-foreground)]">
          {shipment.events.map((e) => (
            <li key={e.id}>
              {when(e.createdAt)} · {SHIPMENT_STATUS_LABELS[e.status as ShipmentStatus] ?? e.status}
              {e.providerStatus ? ` (${e.providerStatus})` : ""}
              {e.note ? ` · ${e.note}` : ""}
              {e.actorUsername ? ` · ${e.actorUsername}` : ""}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

/** Send this order to a connected shop (approved order creation), and resolve an unknown send. */
export function ShopPushPanel({
  orderId,
  providers,
  pushes,
}: {
  orderId: string;
  providers: ShopProvider[];
  pushes: Array<{ id: string; provider: ShopProvider; status: string; externalId: string | null; errors: string[]; startedAt: string }>;
}) {
  const { pending, error, run } = useRun();
  const [reference, setReference] = useState("");
  return (
    <div className="space-y-3 text-sm">
      {pushes.map((p) => (
        <div key={p.id} className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-2 text-xs">
          {SHOP_LABELS[p.provider]}: {p.status === "SUCCEEDED" ? `sent (${p.externalId ?? "?"})` : p.status === "UNKNOWN" ? "outcome unknown" : p.status.toLowerCase()} · {when(p.startedAt)}
          {p.errors[0] ? <span className="block text-[color:var(--color-muted-foreground)]">{p.errors[0]}</span> : null}
          {p.status === "UNKNOWN" ? (
            <div className="mt-2 flex flex-wrap gap-2">
              <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="The shop's order number" className="w-48" />
              <Button size="sm" loading={pending} onClick={() => run(() => resolveShopPush(p.id, true, reference))}>
                It is in the shop
              </Button>
              <Button size="sm" variant="secondary" loading={pending} onClick={() => run(() => resolveShopPush(p.id, false, ""))}>
                It is not
              </Button>
            </div>
          ) : null}
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        {providers.map((p) => (
          <Button key={p} size="sm" variant="secondary" loading={pending} onClick={() => run(() => pushOrderToShop(orderId, p))}>
            Send to {SHOP_LABELS[p]}
          </Button>
        ))}
      </div>
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </div>
  );
}
