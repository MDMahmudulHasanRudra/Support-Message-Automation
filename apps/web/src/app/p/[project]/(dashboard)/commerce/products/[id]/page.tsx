import { notFound } from "next/navigation";
import Link from "@/components/ProjectLink";
import { fromMinor } from "@support-automation/shared";
import { pageAccess } from "@/server/authorize";
import { getProduct, listCategories } from "@/server/commerce";
import { ButtonLink, Card, PageHeader, SectionHeader, Table, Td, Th, ViewOnlyNotice } from "@/components/ui";
import { ProductForm } from "../ProductForm";
import { StockAdjuster, VariantPanel } from "./ProductPanels";

export const metadata = { title: "Product" };

const when = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

const REASON_LABELS: Record<string, string> = { ADJUSTMENT: "Adjusted", ORDER: "Order", RETURN: "Return", CANCEL: "Order cancelled", SYNC: "Shop sync" };

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { canManage } = await pageAccess("commerce.view", "commerce.manage");
  const { id } = await params;
  const [product, categories] = await Promise.all([getProduct(id), listCategories()]);
  if (!product) notFound();

  return (
    <div>
      <PageHeader
        title={product.name}
        description={product.trackInventory ? (product.variants.length ? "Stock is counted per variant." : `${product.stockQuantity} in stock.`) : "Stock is not tracked for this product."}
        actions={<ButtonLink href="/commerce/products">All products</ButtonLink>}
      />
      {canManage ? null : <ViewOnlyNotice />}
      {product.externalSource ? (
        <p className="mb-4 text-sm text-[color:var(--color-muted-foreground)]">Imported from {product.externalSource}. A later sync may change it again.</p>
      ) : null}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[3fr_2fr]">
        <div className="space-y-6">
          {canManage ? (
            <Card>
              <SectionHeader title="Details" />
              <ProductForm
                productId={product.id}
                categories={categories.map((c) => ({ id: c.id, name: c.name }))}
                defaults={{
                  name: product.name,
                  description: product.description ?? "",
                  sku: product.sku ?? "",
                  categoryId: product.categoryId ?? "",
                  status: product.status,
                  currency: product.currency,
                  price: fromMinor(BigInt(product.priceMinor)),
                  compareAt: product.compareAtMinor ? fromMinor(BigInt(product.compareAtMinor)) : "",
                  trackInventory: product.trackInventory,
                  imageUrl: product.imageUrl ?? "",
                }}
              />
            </Card>
          ) : (
            <Card>
              <SectionHeader title="Details" />
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <dt className="text-[color:var(--color-muted-foreground)]">SKU</dt>
                <dd>{product.sku ?? "—"}</dd>
                <dt className="text-[color:var(--color-muted-foreground)]">Price</dt>
                <dd>{fromMinor(BigInt(product.priceMinor))} {product.currency}</dd>
                <dt className="text-[color:var(--color-muted-foreground)]">Status</dt>
                <dd>{product.status}</dd>
              </dl>
              {product.description ? <p className="mt-3 whitespace-pre-wrap text-sm">{product.description}</p> : null}
            </Card>
          )}

          <Card>
            <SectionHeader title="Variants" />
            <VariantPanel
              productId={product.id}
              canManage={canManage}
              trackInventory={product.trackInventory}
              variants={product.variants.map((v) => ({ ...v, priceDecimal: v.priceMinor ? fromMinor(BigInt(v.priceMinor)) : "" }))}
            />
          </Card>
        </div>

        <div className="space-y-6">
          {canManage && product.trackInventory ? (
            <Card>
              <SectionHeader title="Change stock" description="Orders change stock by themselves. Use this for deliveries, counts and damage." />
              <StockAdjuster productId={product.id} variants={product.variants.map((v) => ({ id: v.id, name: v.name }))} />
            </Card>
          ) : null}

          <Card>
            <SectionHeader title="Stock history" description="The latest 50 changes. Every change of stock is listed here." />
            {product.movements.length === 0 ? (
              <p className="text-sm text-[color:var(--color-muted-foreground)]">No stock changes yet.</p>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>When</Th>
                    <Th>Change</Th>
                    <Th>After</Th>
                    <Th>Why</Th>
                  </tr>
                </thead>
                <tbody>
                  {product.movements.map((m) => (
                    <tr key={m.id}>
                      <Td className="whitespace-nowrap text-xs">{when(m.createdAt)}</Td>
                      <Td className={`tabular ${m.delta < 0 ? "text-[color:var(--color-danger)]" : "text-[color:var(--color-success-fg)]"}`}>{m.delta > 0 ? `+${m.delta}` : m.delta}</Td>
                      <Td className="tabular">{m.balanceAfter}</Td>
                      <Td className="text-xs">
                        {REASON_LABELS[m.reason] ?? m.reason}
                        {m.variant ? ` · ${m.variant}` : ""}
                        {m.order ? (
                          <>
                            {" · "}
                            <Link className="link" href={`/commerce/orders/${m.order.id}`}>
                              {m.order.number}
                            </Link>
                          </>
                        ) : m.note ? ` · ${m.note}` : ""}
                        <span className="block text-[color:var(--color-muted-foreground)]">{m.actorUsername}</span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
