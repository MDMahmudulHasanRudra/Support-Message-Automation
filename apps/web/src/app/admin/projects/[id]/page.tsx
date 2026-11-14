import { notFound } from "next/navigation";
import NextLink from "next/link";
import { readClientCodeSeries } from "@support-automation/db";
import { businessAppDefinition, moduleDefinition, previewClientCodes, PROJECT_STATUS_DESCRIPTIONS, PROJECT_TYPE_LABELS } from "@support-automation/shared";
import { ArrowLeft, ArrowRight, Blocks, CheckCircle2, Circle, PartyPopper, Smartphone, UserPlus, Users } from "lucide-react";
import { globalPrisma } from "@/server/db";
import { Alert, Badge, ButtonLink, Card, PageHeader, SectionHeader } from "@/components/ui";
import { ProjectStatusBadge } from "@/components/ProjectSwitcher";
import { getProjectDetail, requireMainAdminPage } from "@/server/mainAdmin";
import { whatsappLine } from "../../ProjectCard";
import { getProjectModuleState } from "@/server/projectModules";
import { ProjectAccessList, ProjectDeletePanel, ProjectDetailsForm, ProjectStatusControl } from "./ProjectControls";
import { BusinessAppsPanel } from "./BusinessAppsPanel";
import { BusinessAppStatusBadge } from "@/components/businessApps/BusinessAppStatusBadge";
import { listProjectInstallations } from "@/server/businessApps";

export const metadata = { title: "Project" };

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "access", label: "Team & Access" },
  { key: "apps", label: "Business Apps" },
  { key: "settings", label: "Settings" },
] as const;
type Tab = (typeof TABS)[number]["key"];

/**
 * One project, from above (MULTI_PROJECT_PLAN.md §8), in three tabs (the owner's Main Admin redesign §4): what it is
 * and how it is doing, who may enter it, and its settings with the lifecycle last. Operational detail is inside the
 * project. A tab is a URL (`?tab=`), so it survives a refresh and can be linked to.
 */
export default async function ProjectDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ created?: string; tab?: string }>;
}) {
  const { session, canManage } = await requireMainAdminPage();
  const { id } = await params;
  const query = await searchParams;
  const detail = await getProjectDetail(session.userId, id);
  if (!detail) notFound();
  const { project, users, configuration } = detail;
  const [modules, codeSeries, installations] = await Promise.all([getProjectModuleState(id), readClientCodeSeries(globalPrisma, id), listProjectInstallations(id)]);
  const liveCodes = codeSeries.find((s) => !s.retiredAt);
  const created = query.created === "1";
  const tab: Tab = TABS.some((t) => t.key === query.tab) ? (query.tab as Tab) : "overview";
  const wa = whatsappLine(project.whatsapp);
  const withAccess = users.filter((u) => u.hasAccess);
  const tabHref = (key: Tab) => `/admin/projects/${project.id}${key === "overview" ? "" : `?tab=${key}`}`;
  const workspaceHref = `/p/${project.slug}/overview`;
  const typeLabel = modules
    ? modules.projectType === "CUSTOM_MIX" && modules.projectBaseType
      ? `Custom (${PROJECT_TYPE_LABELS[modules.projectBaseType]} base)`
      : PROJECT_TYPE_LABELS[modules.projectType]
    : null;

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
            <ButtonLink href={workspaceHref} variant="primary">
              Open workspace
              <ArrowRight className="size-3.5" aria-hidden />
            </ButtonLink>
          ) : null
        }
      />

      <nav aria-label="Project sections" className="mb-6 flex gap-1 overflow-x-auto border-b border-[var(--color-border)]">
        {TABS.map((t) => (
          <NextLink
            key={t.key}
            href={tabHref(t.key)}
            aria-current={tab === t.key ? "page" : undefined}
            className={`-mb-px shrink-0 border-b-2 px-3.5 py-2.5 text-[13.5px] font-medium transition-colors ${
              tab === t.key ? "border-[var(--color-accent)] text-[color:var(--color-foreground)]" : "border-transparent text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
            }`}
          >
            {t.label}
            {t.key === "access" ? <span className="ml-1.5 tabular-nums text-[color:var(--color-subtle-foreground)]">{withAccess.length}</span> : null}
            {t.key === "apps" && installations.length ? <span className="ml-1.5 tabular-nums text-[color:var(--color-subtle-foreground)]">{installations.length}</span> : null}
          </NextLink>
        ))}
      </nav>

      {tab === "overview" ? (
        <div className="space-y-6">
          {created ? (
            <Card className="overflow-hidden !p-0">
              <div className="flex flex-col gap-4 bg-[var(--color-accent-bg)]/50 px-6 py-6 sm:flex-row sm:items-center">
                <span aria-hidden className="flex size-12 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent)] text-white">
                  <PartyPopper className="size-6" />
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="text-[18px] font-semibold tracking-[-0.01em] text-[color:var(--color-foreground)]">Your project is ready</h2>
                  <p className="mt-1 text-[13.5px] leading-relaxed text-[color:var(--color-muted-foreground)]">
                    {project.name} has its own settings and nothing from any other project. Open it to connect your first number, or add the people who will work in it.
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {project.canEnter ? (
                    <ButtonLink href={`/p/${project.slug}/accounts`} variant="primary">
                      <Smartphone className="size-4" aria-hidden />
                      Open workspace
                    </ButtonLink>
                  ) : null}
                  <ButtonLink href="/admin/users/new" variant="secondary">
                    <UserPlus className="size-4" aria-hidden />
                    Add team members
                  </ButtonLink>
                </div>
              </div>
            </Card>
          ) : null}

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <SectionHeader title="How it is doing" description={PROJECT_STATUS_DESCRIPTIONS[project.status]} />
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-[13px]">
                <dt className="text-[color:var(--color-muted-foreground)]">WhatsApp</dt>
                <dd>
                  <Badge color={wa.color} dot>
                    {wa.text}
                  </Badge>
                </dd>
                <dt className="text-[color:var(--color-muted-foreground)]">Messages today</dt>
                <dd className="tabular">{project.messagesToday}</dd>
                <dt className="text-[color:var(--color-muted-foreground)]">Open escalations</dt>
                <dd className="tabular">{project.openEscalations}</dd>
                <dt className="text-[color:var(--color-muted-foreground)]">Monitored groups</dt>
                <dd className="tabular">{project.monitoredGroups}</dd>
                <dt className="text-[color:var(--color-muted-foreground)]">Team members</dt>
                <dd className="tabular">{project.teamMembers}</dd>
              </dl>
            </Card>

            <Card>
              <SectionHeader
                title="Modules"
                description={modules && typeLabel ? `${typeLabel} · ${modules.enabled.length} modules on` : undefined}
                action={
                  <ButtonLink href={`/admin/projects/${project.id}/modules`} variant="secondary" size="sm">
                    <Blocks className="size-3.5" aria-hidden />
                    {canManage ? "Change modules" : "View"}
                  </ButtonLink>
                }
              />
              {modules ? (
                <div className="flex flex-wrap gap-1.5">
                  {modules.enabled.slice(0, 18).map((key) => (
                    <Badge key={key} color="gray">
                      {moduleDefinition(key)?.name ?? key}
                    </Badge>
                  ))}
                  {modules.enabled.length > 18 ? <span className="px-1 text-[12px] text-[color:var(--color-muted-foreground)]">+{modules.enabled.length - 18} more</span> : null}
                </div>
              ) : null}
            </Card>
          </div>

          {installations.length ? (
            <Card>
              <SectionHeader
                title="Business Apps"
                description={`${installations.filter((i) => i.status === "ACTIVE").length} of ${installations.length} connected.`}
                action={
                  <ButtonLink href={tabHref("apps")} variant="secondary" size="sm">
                    Manage
                  </ButtonLink>
                }
              />
              <div className="flex flex-wrap gap-2">
                {installations.map((i) => (
                  <span key={i.id} className="inline-flex items-center gap-2 rounded-full bg-[var(--color-surface-sunken)] py-1 pl-3 pr-1.5 text-[12.5px]">
                    {businessAppDefinition(i.appKey).name}
                    <BusinessAppStatusBadge status={i.status} />
                  </span>
                ))}
              </div>
            </Card>
          ) : null}

          <Card>
            <SectionHeader
              title="Who can enter"
              description={withAccess.length === 0 ? "Nobody has been given access yet, apart from Main Admins." : `${withAccess.length} ${withAccess.length === 1 ? "person has" : "people have"} access.`}
              action={
                <ButtonLink href={tabHref("access")} variant="secondary" size="sm">
                  <Users className="size-3.5" aria-hidden />
                  Manage access
                </ButtonLink>
              }
            />
            {withAccess.length ? (
              <div className="flex flex-wrap gap-2">
                {withAccess.slice(0, 12).map((u) => (
                  <span key={u.id} className="inline-flex items-center gap-2 rounded-full bg-[var(--color-surface-sunken)] py-1 pl-1 pr-3 text-[12.5px]">
                    <span aria-hidden className="flex size-6 items-center justify-center rounded-full bg-[var(--color-accent-bg)] text-[11px] font-semibold text-[color:var(--color-accent-fg)]">
                      {u.name.trim().charAt(0).toUpperCase()}
                    </span>
                    {u.name}
                  </span>
                ))}
                {withAccess.length > 12 ? <span className="py-1 text-[12.5px] text-[color:var(--color-muted-foreground)]">+{withAccess.length - 12} more</span> : null}
              </div>
            ) : null}
          </Card>
        </div>
      ) : null}

      {tab === "access" ? (
        <div className="space-y-4">
          <SectionHeader
            title="Project access"
            description="Who may enter this project, and how much of their role they may use here: Read (look only), Write (day-to-day work, no deleting or settings) or Full (the whole role). A level only narrows the role; it never grants anything the role does not."
            action={
              <ButtonLink href="/admin/users/new" variant="secondary">
                <UserPlus className="size-4" aria-hidden />
                New user
              </ButtonLink>
            }
          />
          <ProjectAccessList projectId={project.id} users={users} canManage={canManage} />
        </div>
      ) : null}

      {tab === "apps" ? (
        <div className="space-y-4">
          <SectionHeader
            title="Business Apps"
            description="Separate business apps this project can use, each with its own data. An app opens from the workspace only after its connection is verified, and only for roles allowed to open Business Apps."
          />
          <BusinessAppsPanel
            projectId={project.id}
            projectSlug={project.slug}
            projectStatus={project.status}
            canManage={canManage}
            canEnter={project.canEnter}
            installations={installations.map((i) => ({
              id: i.id,
              appKey: i.appKey,
              status: i.status,
              lastConnectedAt: i.lastConnectedAt?.toISOString() ?? null,
              lastError: i.lastError,
              lastErrorAt: i.lastErrorAt?.toISOString() ?? null,
              installedByName: i.installedByName,
              createdAt: i.createdAt.toISOString(),
              contractVersion: i.contractVersion,
              externalWorkspaceId: i.externalWorkspaceId,
              credentialHint: i.credentialHint,
            }))}
          />
          {!canManage ? <Alert tone="info">Adding, connecting and disabling Business Apps needs the Manage Projects permission.</Alert> : null}
        </div>
      ) : null}

      {tab === "settings" ? (
        <div className="space-y-6">
          {canManage ? (
            <Card>
              <SectionHeader title="General" description="The name and description. Renaming changes only what people see; nothing in the project moves." />
              <ProjectDetailsForm projectId={project.id} name={project.name} slug={project.slug} description={project.description} />
            </Card>
          ) : null}

          <Card>
            <SectionHeader
              title="Modules & features"
              description="A module that is off is hidden and refused in this project, whatever anyone's role allows. Its data and settings are kept for when it is switched back on."
              action={
                <ButtonLink href={`/admin/projects/${project.id}/modules`} variant="primary">
                  <Blocks className="size-4" aria-hidden />
                  {canManage ? "Open Module Builder" : "View modules"}
                </ButtonLink>
              }
            />
            {modules && typeLabel ? (
              <p className="text-[13px] text-[color:var(--color-muted-foreground)]">
                <span className="font-semibold text-[color:var(--color-foreground)]">{typeLabel}</span> · {modules.enabled.length} modules on · configuration v{modules.version}
              </p>
            ) : null}
          </Card>

          <details className="group rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)]">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 [&::-webkit-details-marker]:hidden">
              <span>
                <span className="block text-[14px] font-semibold text-[color:var(--color-foreground)]">Advanced</span>
                <span className="block text-[12.5px] text-[color:var(--color-muted-foreground)]">Client codes and the project&apos;s own settings rows.</span>
              </span>
              <ArrowRight className="size-4 shrink-0 text-[color:var(--color-muted-foreground)] transition-transform group-open:rotate-90" aria-hidden />
            </summary>
            <div className="space-y-5 border-t border-[var(--color-border)] px-5 py-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-[color:var(--color-foreground)]">Client codes</p>
                  <p className="text-[12.5px] text-[color:var(--color-muted-foreground)]">
                    {liveCodes ? (
                      <>
                        {liveCodes.isPrimary ? "Numbers only (primary project)" : `Prefix ${liveCodes.prefix}`} · next{" "}
                        <span className="font-mono">{previewClientCodes(liveCodes.prefix, liveCodes.nextSerial, liveCodes.minWidth).join(", ")}</span>
                      </>
                    ) : (
                      "No code series yet; one is created with the first client."
                    )}
                  </p>
                </div>
                <ButtonLink href={`/admin/projects/${project.id}/client-codes`} variant="secondary" size="sm">
                  {canManage ? "Manage client codes" : "View client codes"}
                </ButtonLink>
              </div>
              <div>
                <p className="mb-2 text-[13px] font-medium text-[color:var(--color-foreground)]">Settings rows</p>
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
                        {item.present ? "" : " (created with defaults when first opened)"}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </details>

          <Card className="border-[color-mix(in_oklab,var(--color-danger)_35%,var(--color-border))]">
            <SectionHeader title="Danger zone" description="Suspend pauses the project, Archive puts it away, Restore brings an archived one back. Nothing is deleted unless you delete it below." />
            {canManage ? (
              <ProjectStatusControl projectId={project.id} projectName={project.name} status={project.status} />
            ) : (
              <p className="text-[13px] text-[color:var(--color-muted-foreground)]">Changing a project&apos;s status needs the Manage Projects permission.</p>
            )}
            {canManage && project.status === "ARCHIVED" ? (
              <div className="mt-5 border-t border-[var(--color-border)] pt-5">
                <p className="mb-1 text-[13px] font-semibold text-[color:var(--color-foreground)]">Delete permanently</p>
                <p className="mb-3 text-[12.5px] text-[color:var(--color-muted-foreground)]">Removes every message, client and setting in it. This cannot be undone. Never a customer&apos;s last project.</p>
                <ProjectDeletePanel projectId={project.id} projectName={project.name} />
              </div>
            ) : null}
          </Card>
        </div>
      ) : null}

      {!canManage && tab === "settings" ? (
        <div className="mt-4">
          <Alert tone="info">Your role can look at this project but not change it.</Alert>
        </div>
      ) : null}
    </div>
  );
}
