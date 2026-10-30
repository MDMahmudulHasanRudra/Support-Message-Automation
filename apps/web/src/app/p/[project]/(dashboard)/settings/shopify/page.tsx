import { requireAccess } from "@/server/authorize";
import { shopConnectionView } from "@/server/commerce";
import { publicOrigin } from "@/server/google/oauth";
import { PageHeader } from "@/components/ui";
import { ShopSettingsPanel } from "@/components/commerce/ShopSettingsPanel";

export const metadata = { title: "Shopify" };

export default async function ShopifySettingsPage() {
  await requireAccess("shopify.manage");
  const view = await shopConnectionView("SHOPIFY", publicOrigin());
  return (
    <div>
      <PageHeader
        title="Shopify"
        description="Import the store's products, prices and stock (and its orders, if you choose), keep them current by webhook, and send approved orders to the store as drafts."
      />
      <ShopSettingsPanel provider="SHOPIFY" view={view} canManage />
    </div>
  );
}
