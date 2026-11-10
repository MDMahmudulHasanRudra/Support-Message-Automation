import { PAYMENT_PROVIDERS } from "@support-automation/shared";
import { requireAccess } from "@/server/authorize";
import { gatewaySettingsView } from "@/server/payments/core";
import { PageHeader } from "@/components/ui";
import { GatewayForm } from "./GatewayForm";

export const metadata = { title: "Payment accounts" };

/** Settings → Payment accounts (PAYMENT_LINKS.md): the business's own merchant accounts. Details are write-only. */
export default async function PaymentGatewaysPage() {
  await requireAccess("payments.manage", "PAYMENT_LINKS");
  const saved = await gatewaySettingsView();
  return (
    <div className="max-w-2xl space-y-4">
      <PageHeader title="Payment accounts" description="Your own SSLCOMMERZ and bKash merchant accounts. Customers pay into these. Start in test mode." />
      {PAYMENT_PROVIDERS.map((p) => (
        <GatewayForm key={p} provider={p} saved={saved.find((s) => s.provider === p) ?? null} />
      ))}
    </div>
  );
}
