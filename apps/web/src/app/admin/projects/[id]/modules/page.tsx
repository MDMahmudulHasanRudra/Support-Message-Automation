import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { ButtonLink, PageHeader, ViewOnlyNotice } from "@/components/ui";
import { getProjectDetail, requireMainAdminPage } from "@/server/mainAdmin";
import { getProjectModuleState } from "@/server/projectModules";
import { ModuleBuilder } from "./ModuleBuilder";

export const metadata = { title: "Type & modules" };

/**
 * Type & modules (PROJECT_MODULES.md §5): the business type, the Module Builder, and the history of
 * every applied configuration. Visible to `projects.view`; changing anything needs `projects.manage`,
 * which the action checks again itself.
 */
export default async function ProjectModulesPage({ params }: { params: Promise<{ id: string }> }) {
  const { session, canManage } = await requireMainAdminPage();
  const { id } = await params;
  // The same visibility rule as the project page: a project this viewer may not see is a 404.
  const detail = await getProjectDetail(session.userId, id);
  if (!detail) notFound();
  const state = await getProjectModuleState(id);
  if (!state) notFound();

  return (
    <div>
      <ButtonLink href={`/admin/projects/${id}`} variant="ghost" size="sm" className="mb-3">
        <ArrowLeft className="size-3.5" aria-hidden />
        {detail.project.name}
      </ButtonLink>
      <PageHeader
        title="Type & modules"
        description="Choose what this project runs. Required modules are added for you, recommended ones are suggested, and switching a module off hides its pages and stops its background work while keeping all of its data."
      />
      {canManage ? null : (
        <div className="mb-6">
          <ViewOnlyNotice />
        </div>
      )}
      <ModuleBuilder
        projectId={state.projectId}
        projectType={state.projectType}
        projectBaseType={state.projectBaseType}
        version={state.version}
        enabled={state.enabled}
        entitlement={state.entitlement}
        planName={state.planName}
        canManage={canManage}
        history={state.history}
      />
    </div>
  );
}
