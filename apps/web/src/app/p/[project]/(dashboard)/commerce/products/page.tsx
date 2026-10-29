import Link from "@/components/ProjectLink";
import { Plus } from "lucide-react";
import { PRODUCT_STATUS_LABELS, type ProductStatus } from "@support-automation/shared";
import { pageAccess } from "@/server/authorize";
import { listCategories, listProducts } from "@/server/commerce";
import { Badge, ButtonLink, Card, EmptyState, PageHeader, SearchField, SectionHeader, StatTile, Table, Td, Th, ViewOnlyNotice } from "@/components/ui";
import { CategoryManager } from "./CategoryManager";

export const metadata = { title: "Products" };

const STATUS_COLOR = { ACTIVE: "green", DRAFT: "yellow", ARCHIVED: "gray" } as const;
const LOW_STOCK = 5;

export default async function ProductsPage({ searchParams }: { searchParams: Promise<{ search?: string; status?: string; category?: string }> }) {
  const { canManage } = await pageAccess("commerce.view", "commerce.manage");
  const sp = await searchParams;
  const status = sp.status && sp.status in STATUS_COLOR ? sp.status : undefined;
  const [products, categories] = await Promise.all([listProducts({ q: sp.search, status, categoryId: sp.category }), listCategories()]);
  const tracked = products.filter((p) => p.trackInventory);
  const out = tracked.filter((p) => p.variantCount === 0 && p.stockQuantity === 0).length;
  const low = tracked.filter((p) => p.variantCount === 0 && p.stockQuantity > 0 && p.stockQuantity <= LOW_STOCK).length;

  const filterLink = (s?: string) => {
    const q = new URLSearchParams();
    if (sp.search) q.set("search", sp.search);
    if (sp.category) q.set("category", sp.category);
    if (s) q.set("status", s);
    const str = q.toString();
    return `/commerce/products${str ? `?${str}` : ""}`;
  };

  return (
    <div>
      <PageHeader
        title="Products"
        description="Your catalogue: what you sell, its price and how many are in stock. Orders are made from these."
        actions={
          canManage ? (
            <ButtonLink href="/commerce/products/new" variant="primary" size="md">
              <Plus className="size-4" aria-hidden /> New product
            </ButtonLink>
          ) : null
        }
      />
      {canManage ? null : <ViewOnlyNotice />}

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Products shown" value={products.length} />
        <StatTile label="Tracking stock" value={tracked.length} />
        <StatTile label={`Low stock (≤ ${LOW_STOCK})`} value={low} tone={low ? "warning" : "neutral"} />
        <StatTile label="Out of stock" value={out} tone={out ? "danger" : "neutral"} />
      </div>

      <Card className="mb-6">
        <SectionHeader title="Categories" />
        <CategoryManager canManage={canManage} categories={categories.map((c) => ({ id: c.id, name: c.name, count: c._count.products }))} />
      </Card>

      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap gap-2 text-sm">
          <Link className={!status ? "font-semibold" : "link"} href={filterLink()}>
            Not archived
          </Link>
          {(Object.keys(STATUS_COLOR) as ProductStatus[]).map((s) => (
            <Link key={s} className={status === s ? "font-semibold" : "link"} href={filterLink(s)}>
              {PRODUCT_STATUS_LABELS[s]}
            </Link>
          ))}
        </div>
        <SearchField placeholder="Name or SKU" defaultValue={sp.search ?? ""} preserve={{ status, category: sp.category }} />
      </div>

      {products.length === 0 ? (
        <EmptyState>{sp.search ? "No product matches that search." : "No products yet. Add the first thing you sell."}</EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Product</Th>
              <Th>SKU</Th>
              <Th>Category</Th>
              <Th>Price</Th>
              <Th>Stock</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {products.map((p) => (
              <tr key={p.id}>
                <Td>
                  <Link className="link font-medium" href={`/commerce/products/${p.id}`}>
                    {p.name}
                  </Link>
                  {p.variantCount ? <span className="ml-2 text-xs text-[color:var(--color-muted-foreground)]">{p.variantCount} variants</span> : null}
                </Td>
                <Td className="font-[family-name:var(--font-mono)] text-xs">{p.sku ?? "—"}</Td>
                <Td>{p.category ?? "—"}</Td>
                <Td className="tabular">{p.price}</Td>
                <Td className="tabular">
                  {!p.trackInventory ? (
                    <span className="text-[color:var(--color-muted-foreground)]">Not tracked</span>
                  ) : p.variantCount ? (
                    <span className="text-[color:var(--color-muted-foreground)]">By variant</span>
                  ) : (
                    <span className={p.stockQuantity === 0 ? "text-[color:var(--color-danger)]" : p.stockQuantity <= LOW_STOCK ? "text-[color:var(--color-warning-fg)]" : ""}>{p.stockQuantity}</span>
                  )}
                </Td>
                <Td>
                  <Badge color={STATUS_COLOR[p.status as ProductStatus] ?? "gray"} dot>
                    {PRODUCT_STATUS_LABELS[p.status as ProductStatus] ?? p.status}
                  </Badge>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
