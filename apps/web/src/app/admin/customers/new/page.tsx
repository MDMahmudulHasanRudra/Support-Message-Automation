import { nextDefaultProjectName } from "@support-automation/shared";
import { Card, PageHeader } from "@/components/ui";
import { platformPrisma } from "@/server/db";
import { requireMainAdminManagePage } from "@/server/mainAdmin";
import { getDomainSettings, unattachedProjects } from "@/server/saasAdmin";
import { NewCustomerForm } from "./NewCustomerForm";

export const metadata = { title: "Add customer" };

export default async function NewCustomerPage() {
  await requireMainAdminManagePage();
  const [projects, allProjects, settings] = await Promise.all([
    unattachedProjects(),
    platformPrisma.project.findMany({ select: { name: true, slug: true } }),
    getDomainSettings(),
  ]);
  return (
    <div className="max-w-2xl">
      <PageHeader
        title="Add customer"
        description="A customer is a company using its own workspace. Give it a new workspace, or attach the workspace it already uses — nothing in an existing workspace is changed by attaching it."
      />
      <Card>
        <NewCustomerForm projects={projects} defaultProjectName={nextDefaultProjectName(allProjects)} rootDomain={settings.rootDomain} />
      </Card>
    </div>
  );
}
