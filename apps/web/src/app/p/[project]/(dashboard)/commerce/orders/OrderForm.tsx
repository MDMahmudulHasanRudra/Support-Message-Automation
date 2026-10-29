"use client";

import { useMemo, useState, useTransition } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { fromMinor, toMinor } from "@support-automation/shared";
import { Alert, Button, Field, Input, Select, Textarea, useToast } from "@/components/ui";
import { createOrder, updateDraftOrder, type OrderInput } from "@/server/actions/commerce";

export interface OrderableProduct {
  id: string;
  name: string;
  sku: string | null;
  currency: string;
  priceMinor: string;
  trackInventory: boolean;
  stockQuantity: number;
  variants: Array<{ id: string; name: string; sku: string | null; priceMinor: string; stockQuantity: number }>;
}

interface Line {
  key: number;
  productId: string;
  variantId: string;
  quantity: string;
  unitPrice: string;
}

export interface OrderFormDefaults {
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  shippingAddress: string;
  channel: string;
  clientId: string;
  notes: string;
  discount: string;
  shipping: string;
  lines: Array<{ productId: string; variantId: string | null; quantity: number; unitPrice: string }>;
}

const CHANNELS: Array<[string, string]> = [
  ["", "Not recorded"],
  ["WHATSAPP", "WhatsApp"],
  ["MESSENGER", "Messenger"],
  ["INSTAGRAM", "Instagram"],
  ["TELEGRAM", "Telegram"],
  ["WEBSITE", "Website"],
  ["PHONE", "Phone"],
  ["WALK_IN", "Walk-in"],
  ["OTHER", "Other"],
];

let nextKey = 1;

/**
 * A draft order: customer, items, discount and shipping. The total shown here is a preview; the
 * server prices every line again from the catalogue (or the typed price) and computes the total itself.
 */
export function OrderForm({
  orderId,
  products,
  clients,
  defaults,
  leadId,
}: {
  orderId?: string;
  products: OrderableProduct[];
  clients: Array<{ id: string; name: string; code: string }>;
  defaults?: Partial<OrderFormDefaults>;
  leadId?: string;
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [head, setHead] = useState({
    customerName: defaults?.customerName ?? "",
    customerPhone: defaults?.customerPhone ?? "",
    customerEmail: defaults?.customerEmail ?? "",
    shippingAddress: defaults?.shippingAddress ?? "",
    channel: defaults?.channel ?? "",
    clientId: defaults?.clientId ?? "",
    notes: defaults?.notes ?? "",
    discount: defaults?.discount ?? "",
    shipping: defaults?.shipping ?? "",
  });
  const [lines, setLines] = useState<Line[]>(() =>
    (defaults?.lines?.length ? defaults.lines : [{ productId: "", variantId: null, quantity: 1, unitPrice: "" }]).map((l) => ({
      key: nextKey++,
      productId: l.productId,
      variantId: l.variantId ?? "",
      quantity: String(l.quantity),
      unitPrice: l.unitPrice,
    })),
  );
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  const setLine = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  function catalogPrice(l: Line): bigint | null {
    const p = byId.get(l.productId);
    if (!p) return null;
    const v = p.variants.find((x) => x.id === l.variantId);
    return BigInt(v?.priceMinor ?? p.priceMinor);
  }

  const preview = useMemo(() => {
    let subtotal = BigInt(0);
    let currency: string | null = null;
    let mixed = false;
    for (const l of lines) {
      const p = byId.get(l.productId);
      if (!p) continue;
      if (currency && currency !== p.currency) mixed = true;
      currency = p.currency;
      const unit = l.unitPrice.trim() ? toMinor(l.unitPrice) : catalogPrice(l);
      const qty = Number(l.quantity);
      if (unit === null || !Number.isInteger(qty) || qty < 1) continue;
      subtotal += unit * BigInt(qty);
    }
    const discount = head.discount.trim() ? (toMinor(head.discount) ?? BigInt(0)) : BigInt(0);
    const shipping = head.shipping.trim() ? (toMinor(head.shipping) ?? BigInt(0)) : BigInt(0);
    return { currency, mixed, subtotal, total: subtotal - discount + shipping };
    // catalogPrice reads byId, which is in the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, head.discount, head.shipping, byId]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const input: OrderInput = {
      ...head,
      lines: lines.filter((l) => l.productId).map((l) => ({ productId: l.productId, variantId: l.variantId || null, quantity: Number(l.quantity), unitPrice: l.unitPrice })),
      leadId,
    };
    startTransition(async () => {
      const r = orderId ? await updateDraftOrder(orderId, input) : await createOrder(input);
      if (r.error) {
        setError(r.error);
        return;
      }
      showToast({ tone: "success", title: r.success ?? "Saved" });
      router.push(`/commerce/orders/${r.id}`);
    });
  }

  return (
    <form onSubmit={submit} className="space-y-6">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Field label="Customer name" required>
          <Input value={head.customerName} onChange={(e) => setHead({ ...head, customerName: e.target.value })} maxLength={160} required />
        </Field>
        <Field label="Phone">
          <Input value={head.customerPhone} onChange={(e) => setHead({ ...head, customerPhone: e.target.value })} maxLength={40} />
        </Field>
        <Field label="Email">
          <Input type="email" value={head.customerEmail} onChange={(e) => setHead({ ...head, customerEmail: e.target.value })} maxLength={200} />
        </Field>
        <Field label="Shipping address" className="md:col-span-2">
          <Textarea value={head.shippingAddress} onChange={(e) => setHead({ ...head, shippingAddress: e.target.value })} rows={2} maxLength={1000} className="min-h-0" />
        </Field>
        <div className="space-y-4">
          <Field label="Came from">
            <Select value={head.channel} onChange={(e) => setHead({ ...head, channel: e.target.value })}>
              {CHANNELS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          {clients.length ? (
            <Field label="Client record">
              <Select value={head.clientId} onChange={(e) => setHead({ ...head, clientId: e.target.value })}>
                <option value="">None</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.code})
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-semibold">Items</p>
        {products.length === 0 ? <Alert tone="warning">There are no active products yet. Add one under Products first.</Alert> : null}
        {lines.map((l) => {
          const p = byId.get(l.productId);
          const unit = catalogPrice(l);
          return (
            <div key={l.key} className="grid grid-cols-1 gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3 sm:grid-cols-[2fr_1.4fr_6rem_8rem_auto]">
              <Select aria-label="Product" value={l.productId} onChange={(e) => setLine(l.key, { productId: e.target.value, variantId: "", unitPrice: "" })}>
                <option value="">Choose a product…</option>
                {products.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                    {x.sku ? ` · ${x.sku}` : ""}
                    {x.trackInventory && !x.variants.length ? ` · ${x.stockQuantity} in stock` : ""}
                  </option>
                ))}
              </Select>
              {p?.variants.length ? (
                <Select aria-label="Variant" value={l.variantId} onChange={(e) => setLine(l.key, { variantId: e.target.value })}>
                  <option value="">Choose…</option>
                  {p.variants.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                      {p.trackInventory ? ` · ${v.stockQuantity} in stock` : ""}
                    </option>
                  ))}
                </Select>
              ) : (
                <span className="self-center text-xs text-[color:var(--color-muted-foreground)]">{p ? "No variants" : ""}</span>
              )}
              <Input aria-label="Quantity" value={l.quantity} onChange={(e) => setLine(l.key, { quantity: e.target.value })} inputMode="numeric" />
              <Input aria-label="Unit price" value={l.unitPrice} onChange={(e) => setLine(l.key, { unitPrice: e.target.value })} inputMode="decimal" placeholder={unit !== null ? fromMinor(unit) : "Price"} />
              <Button type="button" variant="ghost" aria-label="Remove item" onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((x) => x.key !== l.key) : ls))}>
                <Trash2 className="size-4" aria-hidden />
              </Button>
            </div>
          );
        })}
        <Button type="button" variant="secondary" size="sm" onClick={() => setLines((ls) => [...ls, { key: nextKey++, productId: "", variantId: "", quantity: "1", unitPrice: "" }])}>
          <Plus className="size-3.5" aria-hidden /> Add item
        </Button>
        <p className="text-xs text-[color:var(--color-muted-foreground)]">Leave the price empty to use the catalogue price.</p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Field label="Discount">
          <Input value={head.discount} onChange={(e) => setHead({ ...head, discount: e.target.value })} inputMode="decimal" placeholder="0.00" />
        </Field>
        <Field label="Shipping">
          <Input value={head.shipping} onChange={(e) => setHead({ ...head, shipping: e.target.value })} inputMode="decimal" placeholder="0.00" />
        </Field>
        <div className="rounded-[var(--radius-md)] bg-[var(--color-neutral-bg)] p-3 text-sm">
          <div className="flex justify-between">
            <span>Items</span>
            <span className="tabular">{fromMinor(preview.subtotal)}</span>
          </div>
          <div className="mt-1 flex justify-between font-semibold">
            <span>Total</span>
            <span className="tabular">
              {fromMinor(preview.total < BigInt(0) ? BigInt(0) : preview.total)} {preview.currency ?? ""}
            </span>
          </div>
          {preview.mixed ? <p className="mt-2 text-xs text-[color:var(--color-danger)]">Items are in different currencies. An order has one currency.</p> : null}
        </div>
      </div>

      <Field label="Notes" hint="Only your team sees these.">
        <Textarea value={head.notes} onChange={(e) => setHead({ ...head, notes: e.target.value })} rows={2} maxLength={2000} className="min-h-0" />
      </Field>

      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Button type="submit" loading={pending}>
        {orderId ? "Save draft" : "Create draft order"}
      </Button>
    </form>
  );
}
