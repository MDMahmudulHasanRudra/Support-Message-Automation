import { Card, PageHeader, SectionHeader } from "@/components/ui";
import { PROJECT_FEATURES } from "@support-automation/shared";
import { requireMainAdminPage } from "@/server/mainAdmin";
import { getBillingSettings, listPlans } from "@/server/saasBilling";
import { BillingSettingsForm, PlanList } from "./PlansClient";

export const metadata = { title: "Plans" };

export default async function PlansPage() {
  const { canManage } = await requireMainAdminPage();
  const [plans, settings] = await Promise.all([listPlans(), getBillingSettings()]);
  const features = PROJECT_FEATURES.map((f) => ({ key: f.key, label: f.label, defaultEnabled: f.defaultEnabled }));
  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader
        title="Plans"
        description="The packages customers can be on: price, billing period, trial, and what each includes. Changing a plan never changes a customer already on it — they keep the terms they were given until you assign the plan again."
      />
      <Card>
        <SectionHeader title="Plans" />
        <PlanList plans={plans} features={features} canManage={canManage} />
      </Card>
      <Card>
        <SectionHeader title="Billing settings" description="Apply to every customer unless a customer's own subscription says otherwise." />
        <BillingSettingsForm settings={settings} canManage={canManage} />
      </Card>
    </div>
  );
}
