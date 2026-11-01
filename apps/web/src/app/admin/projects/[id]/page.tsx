import { notFound } from "next/navigation";
import { readClientCodeSeries } from "@support-automation/db";
import { previewClientCodes } from "@support-automation/shared";
import { globalPrisma } from "@/server/db";
import { ArrowLeft, ArrowRight, CheckCircle2, Circle } from "lucide-react";
import { moduleDefinition, PROJECT_STATUS_DESCRIPTIONS, PROJECT_TYPE_LABELS } from "@support-automation/shared";
import { Alert, Badge, ButtonLink, Card, PageHeader, SectionHeader } from "@/components/ui";
import { ProjectStatusBadge } from "@/components/ProjectSwitcher";
import { getProjectDetail, requireMainAdminPage } from "@/server/mainAdmin";
import { whatsappLine } from "../../ProjectCard";
import { getProjectModuleState } from "@/server/projectModules";
import { ProjectAccessList, ProjectDetailsForm, ProjectStatusControl } from "./ProjectControls";

export const metadata = { title: "Project" };

/**
 * One project, from above (MULTI_PROJECT_PLAN.md §8): its status and lifecycle, its default
 * configuration, its features, and who may enter it. Operational detail is inside the project.
 */
export default async function ProjectDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ created?: string }>;
}) {
  const { session, canManage } = await requireMainAdminPage();
  const { id } = await params;
  const detail = await getProjectDetail(session.userId, id);
  if (!detail) notFound();
  const { project, users, configuration } = detail;
  const [modules, codeSeries] = await Promise.all([getProjectModuleState(id), readClientCodeSeries(globalPrisma, id)]);
  const liveCodes = codeSeries.find((s) => !s.retiredAt);
  const created = (await searchParams).created === "1";
  const wa = whatsappLine(project.whatsapp);

  return (
    <div>
      <ButtonLink href="/admin/projects" variant="ghost" size="sm" className="mb-3">
        <ArrowLeft className="size-3.5" aria-hidden />
        Projects
      </ButtonLink>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            {project.name}
            <ProjectStatusBadge status={project.status} />
          </span>
        }
        description={project.description ?? `Address: /p/${project.slug}/`}
        actions={
          project.canEnter ? (
            <ButtonLink href={`/p/${project.slug}/overview`} variant="primary">
              Open project
              <ArrowRight className="size-3.5" aria-hidden />
            </ButtonLink>
          ) : null
        }
      />

      {created ? (
        <div className="mb-6">
          <Alert tone="success" title={`${project.name} is ready for setup`}>
            It has its own default settings, features, alert settings and shifts, and nothing from any other project.
            Next, open it and link a WhatsApp account on its Accounts page.
          </Alert>
        </div>
      ) : null}

      {canManage ? (
        <Card className="mb-6">
          <SectionHeader title="Details" description="The project's name and description. Renaming changes only what people see; nothing in the project moves." />
          <ProjectDetailsForm projectId={project.id} name={project.name} slug={project.slug} description={project.description} />
        </Card>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <SectionHeader title="Status" description={PROJECT_STATUS_DESCRIPTIONS[project.status]} />
          {canManage ? (
            <ProjectStatusControl projectId={project.id} projectName={project.name} status={project.status} />
          ) : (
            <p className="text-[13px] text-[color:var(--color-muted-foreground)]">Changing a project&apos;s status needs the Manage Projects permission.</p>
          )}
          <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
            <dt className="text-[color:var(--color-muted-foreground)]">WhatsApp</dt>
            <dd>
              <Badge color={wa.color} dot>
                {wa.text}
              </Badge>
            </dd>
            <dt className="text-[color:var(--color-muted-foreground)]">Monitored groups</dt>
            <dd className="tabular">{project.monitoredGroups}</dd>
            <dt className="text-[color:var(--color-muted-foreground)]">Team members</dt>
            <dd className="tabular">{project.teamMembers}</dd>
            <dt className="text-[color:var(--color-muted-foreground)]">Messages today</dt>
            <dd className="tabular">{project.messagesToday}</dd>
            <dt className="text-[color:var(--color-muted-foreground)]">Open escalations</dt>
            <dd className="tabular">{project.openEscalations}</dd>
          </dl>
        </Card>

        <Card>
          <SectionHeader title="Configuration" description="The project's own settings rows. Each is edited inside the project, on its Settings pages." />
          <ul className="grid grid-cols-1 gap-1.5 text-[13px] sm:grid-cols-2">
            {configuration.map((item) => (
              <li key={item.label} className="flex items-center gap-2">
                {item.present ? (
                  <CheckCircle2 className="size-4 shrink-0 text-[color:var(--color-success)]" aria-hidden />
                ) : (
                  <Circle className="size-4 shrink-0 text-[color:var(--color-subtle-foreground)]" aria-hidden />
                )}
                <span className={item.present ? "text-[color:var(--color-foreground)]" : "text-[color:var(--color-muted-foreground)]"}>
                  {item.label}
                  {item.present ? "" : " — created with defaults when first opened"}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <div className="mt-8">
        <SectionHeader
          title="Client codes"
          description="The codes people see for this project's clients. Changing the format never renames a client; converting existing codes is a separate, previewed step."
          action={
            <ButtonLink href={`/admin/projects/${project.id}/client-codes`} variant="secondary">
              {canManage ? "Manage client codes" : "View client codes"}
              <ArrowRight className="size-3.5" aria-hidden />
            </ButtonLink>
          }
        />
        <Card>
          {liveCodes ? (
            <p className="text-sm">
              <span className="font-semibold">{liveCodes.isPrimary ? "Numbers only (primary project)" : `Prefix ${liveCodes.prefix}`}</span> · next codes{" "}
              <span className="font-mono">{previewClientCodes(liveCodes.prefix, liveCodes.nextSerial, liveCodes.minWidth).join(", ")}</span>
            </p>
          ) : (
            <p className="text-sm text-[color:var(--color-muted-foreground)]">No code series yet; one is created with the first client.</p>
          )}
        </Card>
      </div>

      <div className="mt-8">
        <SectionHeader
          title="Type & modules"
          description="What this project runs. A module that is off is hidden and refused in this project, whatever anyone's role allows; its data and settings are kept for when it is switched back on."
          action={
            <ButtonLink href={`/admin/projects/${project.id}/modules`} variant="secondary">
              {canManage ? "Open Module Builder" : "View modules"}
              <ArrowRight className="size-3.5" aria-hidden />
            </ButtonLink>
          }
        />
        {modules ? (
          <Card>
            <p className="text-sm">
              <span className="font-semibold">
                {modules.projectType === "CUSTOM_MIX" && modules.projectBaseType
                  ? `Custom Mix (${PROJECT_TYPE_LABELS[modules.projectBaseType]} base)`
                  : PROJECT_TYPE_LABELS[modules.projectType]}
              </span>{" "}
              · {modules.enabled.length} modules on · configuration v{modules.version}
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {modules.enabled.map((key) => (
                <Badge key={key} color="gray">
                  {moduleDefinition(key)?.name ?? key}
                </Badge>
              ))}
            </div>
          </Card>
        ) : null}
      </div>

      <div className="mt-8">
        <SectionHeader
          title="Project access"
          description="Who may enter this project, and how much of their role they may use here: Read (look only), Write (day-to-day work, no deleting or settings) or Full (the whole role). A level only ever narrows the existing role — it never grants anything the role does not."
        />
        <ProjectAccessList projectId={project.id} users={users} canManage={canManage} />
      </div>
    </div>
  );
}
