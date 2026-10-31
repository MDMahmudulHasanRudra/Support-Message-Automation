import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { ButtonLink, Card, PageHeader } from "@/components/ui";
import { platformPrisma } from "@/server/db";
import { requireMainAdminManagePage } from "@/server/mainAdmin";
import { TemplateEditor } from "./TemplateEditor";

export const metadata = { title: "Module template" };

/** Create (`/admin/module-templates/new`) or edit one of this customer's templates. */
export default async function ModuleTemplatePage({ params }: { params: Promise<{ id: string }> }) {
  await requireMainAdminManagePage();
  const { id } = await params;
  // The customer-scoped client finds only this customer's own templates; another's is a 404.
  const row = id === "new" ? null : await platformPrisma.moduleTemplate.findFirst({ where: { id, archivedAt: null } });
  if (id !== "new" && !row) notFound();

  return (
    <div className="max-w-5xl">
      <ButtonLink href="/admin/module-templates" variant="ghost" size="sm" className="mb-3">
        <ArrowLeft className="size-3.5" aria-hidden />
        Module templates
      </ButtonLink>
      <PageHeader
        title={row ? `Edit “${row.name}”` : "New module template"}
        description="Choose the modules once, then use the template for any project. Required modules are added automatically; the customer's plan is checked when the template is applied."
      />
      <Card>
        <TemplateEditor
          id={row?.id ?? null}
          initial={{
            name: row?.name ?? "",
            description: row?.description ?? "",
            baseType: row?.baseType === "ECOMMERCE" ? "ECOMMERCE" : "DEFAULT",
            modules: row?.modules ?? [],
            declined: row?.declined ?? [],
            version: row?.version ?? 0,
          }}
        />
      </Card>
    </div>
  );
}
