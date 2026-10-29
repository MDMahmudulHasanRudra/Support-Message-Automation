"use client";

import { useState, useTransition } from "react";
import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { Alert, Badge, Button, Checkbox, Field, Input, Select, Table, Td, Th, useToast } from "@/components/ui";
import { adjustStock, saveVariant } from "@/server/actions/commerce";

interface Variant {
  id: string;
  name: string;
  sku: string | null;
  priceDecimal: string;
  price: string;
  stockQuantity: number;
  isActive: boolean;
}

function useRun() {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<{ error?: string; success?: string }>, after?: () => void) => {
    setError(null);
    startTransition(async () => {
      const r = await fn();
      if (r.error) {
        setError(r.error);
        return;
      }
      showToast({ tone: "success", title: r.success ?? "Saved" });
      after?.();
      router.refresh();
    });
  };
  return { pending, error, run };
}

/** Stock by hand: add a delivery, remove damaged items, correct a count. Every change is a movement. */
export function StockAdjuster({ productId, variants }: { productId: string; variants: Array<{ id: string; name: string }> }) {
  const { pending, error, run } = useRun();
  const [variantId, setVariantId] = useState(variants[0]?.id ?? "");
  const [delta, setDelta] = useState("");
  const [note, setNote] = useState("");
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => adjustStock(productId, variants.length ? variantId : null, delta, note), () => {
          setDelta("");
          setNote("");
        });
      }}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_8rem_2fr_auto]">
        {variants.length ? (
          <Field label="Variant">
            <Select value={variantId} onChange={(e) => setVariantId(e.target.value)}>
              {variants.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <div />
        )}
        <Field label="Change" hint="e.g. 10 or -3">
          <Input value={delta} onChange={(e) => setDelta(e.target.value)} inputMode="numeric" required />
        </Field>
        <Field label="Reason">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Supplier delivery, stock count, damaged…" maxLength={500} required />
        </Field>
        <div className="flex items-start pt-6">
          <Button type="submit" loading={pending}>
            Apply
          </Button>
        </div>
      </div>
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </form>
  );
}

/** The product's variants (size, colour…), each with its own SKU, price and stock. */
export function VariantPanel({ productId, variants, canManage, trackInventory }: { productId: string; variants: Variant[]; canManage: boolean; trackInventory: boolean }) {
  const { pending, error, run } = useRun();
  const [editing, setEditing] = useState<string | null>(null);
  const blank = { name: "", sku: "", price: "", isActive: true, openingStock: "0" };
  const [form, setForm] = useState(blank);

  function startEdit(v: Variant) {
    setEditing(v.id);
    setForm({ name: v.name, sku: v.sku ?? "", price: v.priceDecimal, isActive: v.isActive, openingStock: "0" });
  }

  return (
    <div className="space-y-4">
      {variants.length ? (
        <Table>
          <thead>
            <tr>
              <Th>Variant</Th>
              <Th>SKU</Th>
              <Th>Price</Th>
              <Th>Stock</Th>
              <Th>State</Th>
              {canManage ? <Th>Actions</Th> : null}
            </tr>
          </thead>
          <tbody>
            {variants.map((v) => (
              <tr key={v.id}>
                <Td className="font-medium">{v.name}</Td>
                <Td className="font-[family-name:var(--font-mono)] text-xs">{v.sku ?? "—"}</Td>
                <Td className="tabular">{v.price}</Td>
                <Td className="tabular">{trackInventory ? v.stockQuantity : "—"}</Td>
                <Td>
                  <Badge color={v.isActive ? "green" : "gray"}>{v.isActive ? "Offered" : "Hidden"}</Badge>
                </Td>
                {canManage ? (
                  <Td>
                    <Button size="sm" variant="secondary" onClick={() => startEdit(v)}>
                      Edit
                    </Button>
                  </Td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <p className="text-sm text-[color:var(--color-muted-foreground)]">No variants. Add them when one product comes in sizes or colours.</p>
      )}

      {canManage ? (
        <form
          className="space-y-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] p-4"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => saveVariant(productId, editing, form), () => {
              setEditing(null);
              setForm(blank);
            });
          }}
        >
          <p className="text-sm font-semibold">{editing ? "Edit variant" : "Add a variant"}</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <Field label="Name" required>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Red / XL" maxLength={120} required />
            </Field>
            <Field label="SKU">
              <Input value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} maxLength={64} />
            </Field>
            <Field label="Price" hint="Empty = the product's price">
              <Input value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} inputMode="decimal" />
            </Field>
            {editing ? (
              <label className="flex items-center gap-2 pt-6 text-sm">
                <Checkbox checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} /> Offered
              </label>
            ) : trackInventory ? (
              <Field label="Opening stock">
                <Input value={form.openingStock} onChange={(e) => setForm({ ...form, openingStock: e.target.value })} inputMode="numeric" />
              </Field>
            ) : null}
          </div>
          {error ? <Alert tone="danger">{error}</Alert> : null}
          <div className="flex gap-2">
            <Button type="submit" loading={pending}>
              {editing ? "Save variant" : "Add variant"}
            </Button>
            {editing ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setEditing(null);
                  setForm(blank);
                }}
              >
                Cancel
              </Button>
            ) : null}
          </div>
        </form>
      ) : null}
    </div>
  );
}
