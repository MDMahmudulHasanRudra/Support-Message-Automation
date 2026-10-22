import { Card, PageHeader, SectionHeader } from "@/components/ui";
import { PROJECT_FEATURES } from "@support-automation/shared";
import { requireOperatorPage } from "@/server/platform/auth";
import { getBillingSettings, listPlans } from "@/server/platform/billing";
import { BillingSettingsForm, PlanList } from "./PlansClient";

export const metadata = { title: "Plans & billing" };

export default async function PlansPage() {
  await requireOperatorPage();
  const canManage = true;
  const [plans, settings] = await Promise.all([listPlans(), getBillingSettings()]);
  // A switch that needs its own approval (manualOnly) is never part of a plan, so it is not offered here.
  const features = PROJECT_FEATURES.filter((f) => !("manualOnly" in f && f.manualOnly)).map((f) => ({ key: f.key, label: f.label, defaultEnabled: f.defaultEnabled }));
  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader
        title="Plans & billing"
        description="The packages customers can be on: price, billing period, trial, and what each includes. Changing a plan never changes a customer already on it — they keep the terms they were given until you assign the plan again."
      />
      <Card>
        <SectionHeader title="Plans" />
        <PlanList plans={plans} features={features} canManage={canManage} />
      </Card>
      <Card>
        <SectionHeader title="Billing settings" description="Apply to every customer unless a customer's own subscription says otherwise." />
        <BillingSettingsForm settings={settings} plans={plans} canManage={canManage} />
      </Card>
    </div>
  );
}
