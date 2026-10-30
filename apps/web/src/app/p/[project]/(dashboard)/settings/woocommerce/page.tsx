import { requireAccess } from "@/server/authorize";
import { shopConnectionView } from "@/server/commerce";
import { publicOrigin } from "@/server/google/oauth";
import { PageHeader } from "@/components/ui";
import { ShopSettingsPanel } from "@/components/commerce/ShopSettingsPanel";

export const metadata = { title: "WooCommerce" };

export default async function WooCommerceSettingsPage() {
  await requireAccess("woocommerce.manage");
  const view = await shopConnectionView("WOOCOMMERCE", publicOrigin());
  return (
    <div>
      <PageHeader
        title="WooCommerce"
        description="Import the shop's products, prices and stock (and its orders, if you choose), keep them current by webhook, and send approved orders to the shop."
      />
      <ShopSettingsPanel provider="WOOCOMMERCE" view={view} canManage />
    </div>
  );
}
