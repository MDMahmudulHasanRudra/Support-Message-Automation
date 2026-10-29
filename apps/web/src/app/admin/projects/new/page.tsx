import { Card, PageHeader } from "@/components/ui";
import { nextDefaultProjectName } from "@support-automation/shared";
import { platformPrisma } from "@/server/db";
import { requireMainAdminManagePage } from "@/server/mainAdmin";
import { currentTenant } from "@/server/tenant";
import { moduleTemplateOptions, projectEntitlement } from "@/server/projectModules";
import { CreateProjectForm } from "./CreateProjectForm";

export const metadata = { title: "Create project" };

export default async function NewProjectPage() {
  await requireMainAdminManagePage();
  // The form starts with the next free "RELQIVO Project N" (BRANDING.md §Defaults); the admin can type anything.
  const existing = await platformPrisma.project.findMany({ select: { name: true, slug: true } });
  const tenant = await currentTenant();
  const [templates, { planName }] = await Promise.all([moduleTemplateOptions(tenant), projectEntitlement(tenant)]);
  return (
    <div className="max-w-2xl">
      <PageHeader
        title="Create project"
        description="A new project starts clean: nothing is copied from any other project. It gets its own default settings (automation off, AI off), the default shifts and alert settings, and you get access to it. WhatsApp numbers, AI providers, rules, teams and knowledge are then set up inside the project."
      />
      <Card>
        <CreateProjectForm
          defaultName={nextDefaultProjectName(existing)}
          planName={planName}
          templates={templates.map((t) => ({ key: t.key, name: t.name, description: t.description, builtIn: t.builtIn, moduleCount: t.modules.length }))}
        />
      </Card>
    </div>
  );
}
