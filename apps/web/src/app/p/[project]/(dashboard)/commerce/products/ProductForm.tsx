"use client";

import { useState, useTransition } from "react";
import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { Alert, Button, Checkbox, Field, Input, Select, Textarea, useToast } from "@/components/ui";
import { saveProduct, type ProductInput } from "@/server/actions/commerce";

export interface ProductFormDefaults {
  name: string;
  description: string;
  sku: string;
  categoryId: string;
  status: string;
  currency: string;
  price: string;
  compareAt: string;
  trackInventory: boolean;
  imageUrl: string;
}

const EMPTY: ProductFormDefaults = { name: "", description: "", sku: "", categoryId: "", status: "ACTIVE", currency: "BDT", price: "", compareAt: "", trackInventory: true, imageUrl: "" };

/** Create (new page) or edit (product page) one product. Prices are typed as decimals and stored as minor units. */
export function ProductForm({ productId, defaults, categories }: { productId?: string; defaults?: ProductFormDefaults; categories: Array<{ id: string; name: string }> }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [form, setForm] = useState<ProductFormDefaults>(defaults ?? EMPTY);
  const [newCategory, setNewCategory] = useState("");
  const [openingStock, setOpeningStock] = useState("0");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const set = <K extends keyof ProductFormDefaults>(k: K, v: ProductFormDefaults[K]) => setForm((f) => ({ ...f, [k]: v }));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const input: ProductInput = { ...form, newCategory, openingStock };
    startTransition(async () => {
      const result = await saveProduct(productId ?? null, input);
      if (result.error) {
        setError(result.error);
        return;
      }
      showToast({ tone: "success", title: result.success ?? "Saved" });
      if (!productId && result.id) router.push(`/commerce/products/${result.id}`);
      else router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Name" required>
          <Input value={form.name} onChange={(e) => set("name", e.target.value)} maxLength={200} required />
        </Field>
        <Field label="SKU" hint="Optional. Unique in this project.">
          <Input value={form.sku} onChange={(e) => set("sku", e.target.value)} maxLength={64} />
        </Field>
        <Field label="Category">
          <Select value={form.categoryId} onChange={(e) => set("categoryId", e.target.value)}>
            <option value="">No category</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="…or a new category" hint="Typed here, it is created and used.">
          <Input value={newCategory} onChange={(e) => setNewCategory(e.target.value)} maxLength={120} placeholder="e.g. Shirts" />
        </Field>
        <Field label="Currency" required hint="Three letters, e.g. BDT or USD.">
          <Input value={form.currency} onChange={(e) => set("currency", e.target.value.toUpperCase())} maxLength={3} required />
        </Field>
        <Field label="Price" required>
          <Input value={form.price} onChange={(e) => set("price", e.target.value)} inputMode="decimal" placeholder="0.00" required />
        </Field>
        <Field label="Compare-at price" hint="Optional: the old price, shown struck through.">
          <Input value={form.compareAt} onChange={(e) => set("compareAt", e.target.value)} inputMode="decimal" />
        </Field>
        <Field label="Status">
          <Select value={form.status} onChange={(e) => set("status", e.target.value)}>
            <option value="ACTIVE">Active — can be ordered</option>
            <option value="DRAFT">Draft — not offered yet</option>
            <option value="ARCHIVED">Archived — kept for history</option>
          </Select>
        </Field>
        <Field label="Image address" hint="Optional. https:// only." className="md:col-span-2">
          <Input value={form.imageUrl} onChange={(e) => set("imageUrl", e.target.value)} maxLength={1000} placeholder="https://…" />
        </Field>
        <Field label="Description" className="md:col-span-2">
          <Textarea value={form.description} onChange={(e) => set("description", e.target.value)} rows={4} maxLength={5000} />
        </Field>
      </div>
      <div className="flex flex-wrap items-end gap-6">
        <label className="flex max-w-md items-start gap-2 text-sm">
          <Checkbox checked={form.trackInventory} onChange={(e) => set("trackInventory", e.target.checked)} className="mt-0.5" />
          <span>
            <span className="font-medium">Track stock</span>
            <span className="block text-xs text-[color:var(--color-muted-foreground)]">
              Confirming an order takes items out of stock; cancelling it or a return puts them back.
            </span>
          </span>
        </label>
        {!productId && form.trackInventory ? (
          <Field label="Opening stock">
            <Input value={openingStock} onChange={(e) => setOpeningStock(e.target.value)} inputMode="numeric" className="w-32" />
          </Field>
        ) : null}
      </div>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Button type="submit" loading={pending}>
        {productId ? "Save product" : "Create product"}
      </Button>
    </form>
  );
}
