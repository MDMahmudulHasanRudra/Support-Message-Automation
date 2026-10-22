import { prisma as globalPrisma } from "@support-automation/db";
import { Card, PageHeader } from "@/components/ui";
import { requireOperatorPage } from "@/server/platform/auth";
import { canAdoptOriginalInstallation, getDomainSettings } from "@/server/platform/customers";
import { getBillingSettings, listPlans } from "@/server/platform/billing";
import { NewCustomerForm } from "./NewCustomerForm";

export const metadata = { title: "Add customer" };

export default async function NewCustomerPage() {
  await requireOperatorPage();
  const [settings, plans, billing, canAdopt, takenSlugs] = await Promise.all([
    getDomainSettings(),
    listPlans(),
    getBillingSettings(),
    canAdoptOriginalInstallation(),
    globalPrisma.project.count(),
  ]);
  const activePlans = plans.filter((p) => p.isActive);
  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Add customer"
        description="A new customer gets its own complete copy of the software — its own Main Admin, workspace, roles and settings — on its own address. The original installation is added once, unchanged."
      />
      <Card>
        <NewCustomerForm
          plans={activePlans.map((p) => ({ id: p.id, name: p.name, priceMinor: p.priceMinor, currency: p.currency, interval: p.interval, allModules: p.allModules }))}
          defaultPlanId={activePlans.some((p) => p.id === billing.defaultPlanId) ? billing.defaultPlanId : null}
          defaultGraceDays={billing.defaultGraceDays}
          rootDomain={settings.rootDomain}
          canAdoptOriginal={canAdopt}
          suggestedWorkspace={`Workspace ${takenSlugs + 1}`}
        />
      </Card>
    </div>
  );
}
