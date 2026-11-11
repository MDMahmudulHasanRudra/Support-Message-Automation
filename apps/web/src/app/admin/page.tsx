import { cookies } from "next/headers";
import NextLink from "next/link";
import {
  Activity,
  AlertTriangle,
  Archive,
  ArrowRight,
  Blocks,
  Bot,
  Building2,
  CheckCircle2,
  FolderKanban,
  HeartPulse,
  Layers,
  ListChecks,
  MessagesSquare,
  Palette,
  PauseCircle,
  Plus,
  Rocket,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  TrendingUp,
  Users,
  UsersRound,
  Wrench,
  Zap,
} from "lucide-react";
import { PROJECT_STATUS_LABELS, type ProjectStatusValue } from "@support-automation/shared";
import { Badge, ButtonLink, Card, HeroKpi, PageHeader, StatTile, Table, Td, Th } from "@/components/ui";
import { AreaChart, BarList, ChartCard, ChartHeadline, DonutChart, formatCount } from "@/components/charts";
import { ActionList, ChartEmpty, ClosableGuide, GettingStarted, QuickActions, setupGuideCookie, type ActionItem, type QuickAction, type SetupStep } from "@/components/dashboard";
import { ProjectStatusBadge } from "@/components/ProjectSwitcher";
import { combineKpis, getProjectMessageSeries, getProjectSummaries, requireMainAdminPage, type ProjectSummary } from "@/server/mainAdmin";
import { getGrantedPermissionKeys } from "@/server/permissions";
import { whatsappLine } from "./ProjectCard";
import { WelcomeSetup, type WelcomeStep } from "./WelcomeSetup";
import { platformPrisma } from "@/server/db";
import { getBranding } from "@/server/branding";

export const metadata = { title: "Dashboard" };

const STATUS_COLOR: Record<ProjectStatusValue, string> = {
  ACTIVE: "var(--color-success)",
  SETUP: "var(--chart-1)",
  SUSPENDED: "var(--color-warning)",
  ARCHIVED: "var(--color-border-strong)",
};

function greetingFor(nowMs: number): string {
  const hour = new Date(nowMs + 6 * 3_600_000).getUTCHours();
  return hour < 5 ? "Good night" : hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
}

/** The project's reading in one word, from the same attention reasons the portal already worked out. */
function healthOf(project: ProjectSummary): { label: string; color: "green" | "yellow" | "red" | "gray" } {
  if (project.status === "SUSPENDED") return { label: "On hold", color: "yellow" };
  if (project.whatsapp.down > 0 || project.whatsapp.needsPerson > 0) return { label: "Connection issue", color: "red" };
  if (project.attention.length > 0) return { label: "Needs attention", color: "yellow" };
  if (project.status === "SETUP") return { label: "Setting up", color: "gray" };
  return { label: "Healthy", color: "green" };
}

/**
 * Main Admin Overview (MULTI_PROJECT_PLAN.md §8): this customer's own projects, in which state, whether each
 * one's WhatsApp works, and what needs attention. Built from the same cards as the Project Overview. Figures
 * add up only the projects this person can enter, and every detail stays inside the project. Never billing or
 * plans: those belong to the platform (/platform), not to a customer's Main Admin.
 */
export default async function MainAdminOverview({ searchParams }: { searchParams: Promise<{ guide?: string }> }) {
  const { session, canManage } = await requireMainAdminPage();
  const [projects, grantedKeys] = await Promise.all([getProjectSummaries(session.userId, { includeArchived: true }), getGrantedPermissionKeys(session)]);
  const granted = new Set(grantedKeys);
  const count = (status: ProjectStatusValue) => projects.filter((p) => p.status === status).length;
  const listed = projects.filter((p) => p.status !== "ARCHIVED");
  const needsAttention = listed.filter((p) => p.attention.length > 0);
  const kpis = combineKpis(projects);
  const enterable = listed.filter((p) => p.canEnter);
  // eslint-disable-next-line react-hooks/purity -- server component runs fresh per request
  const nowMs = Date.now();
  const series = await getProjectMessageSeries(enterable.map((p) => p.id), nowMs);

  // Attention first, then the busiest: what somebody came here to find.
  const ordered = [...listed].sort((a, b) => b.attention.length - a.attention.length || b.messagesToday - a.messagesToday);
  const actions: ActionItem[] = needsAttention.map((p) => ({
    key: p.id,
    kind: p.whatsapp.down > 0 || p.whatsapp.needsPerson > 0 ? "down" : "warning",
    title: p.name,
    detail: p.attention.join(" "),
    href: `/admin/projects/${p.id}`,
    action: "Review",
  }));

  const statusSlices = (["ACTIVE", "SETUP", "SUSPENDED", "ARCHIVED"] as ProjectStatusValue[])
    .map((status) => ({ key: status, label: PROJECT_STATUS_LABELS[status], value: count(status), color: STATUS_COLOR[status] }))
    .filter((s) => s.value > 0);

  const quickActions: QuickAction[] = [
    ...(canManage ? [{ label: "Create a project", href: "/admin/projects/new", icon: Plus }] : []),
    { label: "All projects", href: "/admin/projects", icon: FolderKanban },
    { label: "Project templates", href: "/admin/module-templates", icon: Blocks },
    ...(granted.has("users.view") ? [{ label: "Users & access", href: "/admin/users", icon: ShieldCheck }] : []),
    ...(granted.has("configuration.view") ? [{ label: "Organization", href: "/admin/configuration", icon: Building2 }] : []),
    { label: "Branding", href: "/admin/branding", icon: Palette },
  ];

  // The setup steps, ticked from what exists: the welcome screen and the dashboard's guide are one list.
  const [employeeCount, otherLogins, branding, { productName }] = await Promise.all([
    platformPrisma.employee.count(),
    platformPrisma.user.count({ where: { id: { not: session.userId }, supportOperatorId: null } }),
    platformPrisma.platformBranding.findFirst({ select: { productName: true, accentColor: true, assetVersion: true } }),
    getBranding(),
  ]);
  const firstProject = enterable[0];
  const steps: WelcomeStep[] = [
    { key: "project", required: true, title: "Create your first project", detail: "Pick your business type and the modules come ready.", done: listed.length > 0, href: canManage ? "/admin/projects/new" : undefined, action: "Create project" },
    {
      key: "channel",
      required: false,
      title: "Connect WhatsApp or another channel",
      detail: "Link the number or page your customers message.",
      done: kpis.whatsappTotal > 0,
      href: firstProject ? `/p/${firstProject.slug}/accounts` : undefined,
      action: "Connect",
      lockedReason: listed.length === 0 ? "After step 1" : undefined,
    },
    { key: "employees", required: false, title: "Add your employees", detail: "The people in your team, with department and job title.", done: employeeCount > 0, href: granted.has("configuration.manage") ? "/admin/configuration/employees/new" : undefined, action: "Add employee" },
    { key: "access", required: false, title: "Give app access", detail: "A login for each person, with their role and projects.", done: otherLogins > 0, href: granted.has("users.create") ? "/admin/users/new" : undefined, action: "Give access" },
    {
      key: "branding",
      required: false,
      title: "Make it yours",
      detail: "Your logo, name and colour on every screen.",
      done: Boolean(branding && (branding.productName || branding.accentColor || branding.assetVersion > 0)),
      href: "/admin/branding",
      action: "Open branding",
    },
  ];
  const setup: SetupStep[] = steps;

  // No project yet: a welcome screen instead of a dashboard of zeros.
  if (listed.length === 0) return <WelcomeSetup productName={productName} username={session.username} steps={steps} />;

  // The setup guide: closed by this person stays closed, until they ask for it from Quick actions.
  const guideCookie = setupGuideCookie("admin", session.userId);
  const guideClosed = (await cookies()).get(guideCookie)?.value === "1" && (await searchParams).guide !== "1";
  const guideUnfinished = setup.some((step) => !step.done);
  if (guideClosed && guideUnfinished) quickActions.push({ label: "Setup guide", href: "/admin?guide=1", icon: ListChecks });

  const description =
    needsAttention.length > 0
      ? `${needsAttention.length} project${needsAttention.length === 1 ? " needs" : "s need"} attention. Figures add up the ${kpis.projects} project${kpis.projects === 1 ? "" : "s"} you can enter${kpis.excludedProjects > 0 ? `; ${kpis.excludedProjects} more ${kpis.excludedProjects === 1 ? "is" : "are"} listed without access` : ""}.`
      : `Every project is healthy. Figures add up the ${kpis.projects} project${kpis.projects === 1 ? "" : "s"} you can enter${kpis.excludedProjects > 0 ? `; ${kpis.excludedProjects} more ${kpis.excludedProjects === 1 ? "is" : "are"} listed without access` : ""}.`;

  return (
    <div>
      <PageHeader
        title={`${greetingFor(nowMs)}, ${session.username}`}
        description={description}
        actions={
          canManage ? (
            <ButtonLink href="/admin/projects/new" variant="primary">
              <Plus className="size-4" aria-hidden />
              Create project
            </ButtonLink>
          ) : null
        }
      />

      {guideUnfinished && !guideClosed ? (
        <div className="mb-4">
          <ClosableGuide cookieName={guideCookie}>
            <GettingStarted title="Finish setting up" steps={setup} />
          </ClosableGuide>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <HeroKpi tone="tide" icon={Layers} label="Total projects" value={formatCount(projects.length)} href="/admin/projects" sub={`${count("ACTIVE")} active, ${count("SETUP")} in setup`} />
        <HeroKpi
          tone="sea"
          icon={Smartphone}
          label="WhatsApp connected"
          value={`${formatCount(kpis.whatsappConnected)}/${formatCount(kpis.whatsappTotal)}`}
          sub={kpis.whatsappTotal === 0 ? "No number linked yet" : kpis.whatsappNeedsAttention > 0 ? `${kpis.whatsappNeedsAttention} need attention` : "All numbers online"}
        />
        <HeroKpi
          tone="navy"
          icon={MessagesSquare}
          label="Messages today"
          value={formatCount(kpis.messagesToday)}
          sub="Across your projects, since midnight"
          spark={series.daily.map((d) => d.value)}
          sparkLabel="Incoming messages per day across your projects, last 14 days"
        />
        <HeroKpi tone={needsAttention.length > 0 ? "amber" : "tide"} icon={needsAttention.length > 0 ? AlertTriangle : CheckCircle2} label="Projects needing attention" value={formatCount(needsAttention.length)} sub={needsAttention.length > 0 ? (needsAttention[0]?.name ?? "") : `${listed.length} of ${listed.length} healthy`} />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        <StatTile icon={Rocket} label={PROJECT_STATUS_LABELS.ACTIVE} value={count("ACTIVE")} tone={count("ACTIVE") > 0 ? "success" : "neutral"} href="/admin/projects" />
        <StatTile icon={Wrench} label={PROJECT_STATUS_LABELS.SETUP} value={count("SETUP")} tone={count("SETUP") > 0 ? "accent" : "neutral"} href="/admin/projects" />
        <StatTile icon={PauseCircle} label={PROJECT_STATUS_LABELS.SUSPENDED} value={count("SUSPENDED")} tone={count("SUSPENDED") > 0 ? "warning" : "neutral"} href="/admin/projects" />
        <StatTile icon={Archive} label={PROJECT_STATUS_LABELS.ARCHIVED} value={count("ARCHIVED")} href="/admin/projects?archived=1" />
        <StatTile icon={Smartphone} label="Connections needing attention" value={kpis.whatsappNeedsAttention} tone={kpis.whatsappNeedsAttention > 0 ? "danger" : "neutral"} />
        <StatTile icon={Bot} label="AI answers today" value={formatCount(kpis.aiRepliesToday)} tone="accent" />
        <StatTile icon={Activity} label="Support activity today" value={formatCount(kpis.supportActivityToday)} />
        <StatTile icon={ShieldAlert} label="Open escalations" value={formatCount(kpis.openEscalations)} tone={kpis.openEscalations > 0 ? "warning" : "neutral"} />
        <StatTile icon={UsersRound} label="Monitored groups" value={formatCount(kpis.monitoredGroups)} />
        <StatTile icon={Users} label="Active team members" value={formatCount(kpis.activeTeamMembers)} />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-12">
        <ChartCard
          className="lg:col-span-2 xl:col-span-5"
          icon={TrendingUp}
          title="Incoming messages"
          description="Across the projects you can enter, last 14 days."
          headline={<ChartHeadline value={formatCount(series.windowTotal)} caption="14 days" />}
        >
          {series.windowTotal === 0 ? <ChartEmpty text="No messages yet. They start counting once a project has a connected number." /> : <AreaChart data={series.daily} ariaLabel="Incoming messages per day across your projects, last 14 days" />}
        </ChartCard>
        <ChartCard className="xl:col-span-4" icon={HeartPulse} title="Projects by status" description="Every project on this installation.">
          {statusSlices.length === 0 ? <ChartEmpty text="No projects yet." href={canManage ? "/admin/projects/new" : undefined} action="Create a project" /> : <DonutChart slices={statusSlices} total={projects.length} centerLabel="projects" ariaLabel="Projects by status" />}
        </ChartCard>
        <ChartCard className="xl:col-span-3" icon={Zap} title="Busiest today" description="Messages per project, since midnight.">
          <BarList items={[...enterable].sort((a, b) => b.messagesToday - a.messagesToday).filter((p) => p.messagesToday > 0).slice(0, 6).map((p) => ({ id: p.id, label: p.name, value: p.messagesToday }))} emptyMessage="No messages today yet." />
        </ChartCard>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-12">
        <section className="min-w-0 xl:col-span-8" aria-label="Projects">
          <Card className="!p-0">
            <div className="flex items-center justify-between gap-3 px-5 pb-2.5 pt-4">
              <h2 className="flex items-center gap-2 text-[14.5px] font-semibold tracking-[-0.01em] text-[color:var(--color-foreground)]">
                <FolderKanban className="size-[18px] text-[color:var(--color-accent)]" aria-hidden />
                Your projects
              </h2>
              <NextLink href="/admin/projects" className="inline-flex items-center gap-1 text-[12.5px] font-medium text-[color:var(--color-accent-fg)] hover:underline">
                View all
                <ArrowRight className="size-3.5" aria-hidden />
              </NextLink>
            </div>
            {listed.length === 0 ? (
              <div className="px-5 pb-5">
                <ChartEmpty text="No projects yet. A project is one business or team, with its own numbers, people and data." href={canManage ? "/admin/projects/new" : undefined} action="Create your first project" />
              </div>
            ) : (
              <div className="px-2 pb-2">
                <Table>
                  <thead>
                    <tr>
                      <Th>Project</Th>
                      <Th>Status</Th>
                      <Th>Health</Th>
                      <Th>WhatsApp</Th>
                      <Th>Today</Th>
                      <Th>Cases</Th>
                      <Th>
                        <span className="sr-only">Actions</span>
                      </Th>
                    </tr>
                  </thead>
                  <tbody>
                    {ordered.map((project) => {
                      const wa = whatsappLine(project.whatsapp);
                      const health = healthOf(project);
                      return (
                        <tr key={project.id}>
                          <Td>
                            <div className="flex items-center gap-2.5">
                              <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-accent-bg)] text-[12px] font-semibold text-[color:var(--color-accent-fg)]">
                                {project.name.trim().charAt(0).toUpperCase()}
                              </span>
                              <span className="min-w-0">
                                <NextLink href={`/admin/projects/${project.id}`} className="block max-w-[14rem] truncate font-medium text-[color:var(--color-foreground)] hover:underline">
                                  {project.name}
                                </NextLink>
                                <span className="block text-[11.5px] text-[color:var(--color-muted-foreground)]">/p/{project.slug}</span>
                              </span>
                            </div>
                          </Td>
                          <Td>
                            <ProjectStatusBadge status={project.status} />
                          </Td>
                          <Td>
                            <Badge color={health.color} dot>
                              {health.label}
                            </Badge>
                          </Td>
                          <Td>
                            <Badge color={wa.color} dot>
                              {wa.text}
                            </Badge>
                          </Td>
                          <Td className="tabular">{project.messagesToday.toLocaleString()}</Td>
                          <Td className="tabular">{project.openEscalations.toLocaleString()}</Td>
                          <Td>
                            {project.canEnter ? (
                              <ButtonLink href={`/p/${project.slug}/overview`}>Open</ButtonLink>
                            ) : (
                              <span className="text-xs text-[color:var(--color-muted-foreground)]">No access</span>
                            )}
                          </Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </Table>
              </div>
            )}
          </Card>
        </section>
        <div className="space-y-4 xl:col-span-4">
          <ActionList items={actions.slice(0, 5)} hiddenCount={Math.max(0, actions.length - 5)} emptyText="A project with a connection problem or an unfinished setup appears here." />
          <QuickActions icon={Zap} actions={quickActions} />
        </div>
      </div>
    </div>
  );
}
