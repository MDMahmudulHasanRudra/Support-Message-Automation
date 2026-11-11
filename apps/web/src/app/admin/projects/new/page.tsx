import { PageHeader } from "@/components/ui";
import { reservedClientCodePrefixes } from "@support-automation/db";
import { codeTenantKey, moduleDefinition, nextDefaultProjectName } from "@support-automation/shared";
import { globalPrisma, platformPrisma } from "@/server/db";
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
  const [templates, { planName }, reserved] = await Promise.all([
    moduleTemplateOptions(tenant),
    projectEntitlement(tenant),
    reservedClientCodePrefixes(globalPrisma, codeTenantKey(tenant)),
  ]);
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Create a project" description="One business or team, with its own numbers, people and conversations. Nothing is copied from any other project." />
      <div>
        <CreateProjectForm
          defaultName={nextDefaultProjectName(existing)}
          planName={planName}
          codeContext={{ primary: !reserved.some((r) => r.prefix === ""), reserved: reserved.map((r) => ({ prefix: r.prefix, projectName: r.projectName })) }}
          templates={templates.map((t) => ({
            key: t.key,
            name: t.name,
            description: t.description,
            builtIn: t.builtIn,
            moduleCount: t.modules.length,
            moduleNames: t.modules.map((key) => moduleDefinition(key)?.name ?? key),
          }))}
        />
      </div>
    </div>
  );
}
