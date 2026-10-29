import { Plus } from "lucide-react";
import { moduleDefinition, PROJECT_TYPE_LABELS } from "@support-automation/shared";
import { Badge, ButtonLink, Card, PageHeader, SectionHeader, ViewOnlyNotice } from "@/components/ui";
import { platformPrisma } from "@/server/db";
import { requireMainAdminPage } from "@/server/mainAdmin";
import { currentTenant } from "@/server/tenant";
import { moduleTemplateOptions } from "@/server/projectModules";
import { TemplateRowActions } from "./TemplateRowActions";

export const metadata = { title: "Module templates" };

/**
 * Module templates (PROJECT_MODULES.md §8): the built-ins, then this customer's own. Applying one is
 * done from a project's Module Builder or when creating a project; a template never changes a project
 * by itself.
 */
export default async function ModuleTemplatesPage() {
  const { canManage } = await requireMainAdminPage();
  const tenant = await currentTenant();
  const [templates, archived] = await Promise.all([
    moduleTemplateOptions(tenant),
    platformPrisma.moduleTemplate.findMany({ where: { archivedAt: { not: null } }, orderBy: { archivedAt: "desc" }, select: { id: true, name: true, archivedAt: true } }),
  ]);
  const builtIns = templates.filter((t) => t.builtIn);
  const own = templates.filter((t) => !t.builtIn);

  return (
    <div>
      <PageHeader
        title="Module templates"
        description="Reusable module selections. Use one when creating a project or from a project's Type & modules page. Editing a template never changes a project that already used it."
        actions={
          canManage ? (
            <ButtonLink href="/admin/module-templates/new" variant="primary">
              <Plus className="size-4" aria-hidden />
              New template
            </ButtonLink>
          ) : null
        }
      />
      {canManage ? null : (
        <div className="mb-6">
          <ViewOnlyNotice />
        </div>
      )}

      <SectionHeader title="Your templates" description="Private to your organisation." />
      {own.length === 0 ? (
        <Card>
          <p className="text-sm text-[color:var(--color-muted-foreground)]">None yet. Create one, or duplicate a built-in below and adjust it.</p>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {own.map((t) => (
            <TemplateCard key={t.key} name={t.name} description={t.description} baseType={t.baseType} modules={t.modules} badge={`v${t.version}`}>
              <TemplateRowActions templateKey={t.key} canManage={canManage} editable />
            </TemplateCard>
          ))}
        </div>
      )}

      <div className="mt-8">
        <SectionHeader title="Built-in" description="Provided with Get Assist. Duplicate one to make your own version." />
        <div className="grid gap-3 md:grid-cols-2">
          {builtIns.map((t) => (
            <TemplateCard key={t.key} name={t.name} description={t.description} baseType={t.baseType} modules={t.modules} badge="Built-in">
              <TemplateRowActions templateKey={t.key} canManage={canManage} editable={false} />
            </TemplateCard>
          ))}
        </div>
      </div>

      {archived.length > 0 ? (
        <div className="mt-8">
          <SectionHeader title="Archived" description="Not offered any more. Projects that used them keep their modules." />
          <ul className="divide-y divide-[var(--color-border)] rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)]">
            {archived.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
                <span>
                  {a.name} <span className="text-xs text-[color:var(--color-muted-foreground)]">archived {a.archivedAt?.toLocaleDateString()}</span>
                </span>
                <TemplateRowActions templateKey={a.id} canManage={canManage} editable={false} archived />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function TemplateCard({
  name,
  description,
  baseType,
  modules,
  badge,
  children,
}: {
  name: string;
  description: string | null;
  baseType: "DEFAULT" | "ECOMMERCE";
  modules: string[];
  badge: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold">{name}</p>
          <p className="text-xs text-[color:var(--color-muted-foreground)]">
            {PROJECT_TYPE_LABELS[baseType]} base · {modules.length} modules
          </p>
        </div>
        <Badge color="gray">{badge}</Badge>
      </div>
      {description ? <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">{description}</p> : null}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {modules.map((k) => (
          <Badge key={k} color="blue">
            {moduleDefinition(k)?.name ?? k}
          </Badge>
        ))}
      </div>
      <div className="mt-4">{children}</div>
    </Card>
  );
}
