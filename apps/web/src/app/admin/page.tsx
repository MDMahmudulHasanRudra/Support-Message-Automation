import { cookies } from "next/headers";
import NextLink from "next/link";
import {
  Activity,
  AlarmClock,
  AlertTriangle,
  ArrowRight,
  Blocks,
  Bot,
  Building2,
  CalendarClock,
  CheckCircle2,
  FolderKanban,
  HeartPulse,
  History,
  KeyRound,
  Layers,
  ListChecks,
  MessagesSquare,
  Palette,
  PlugZap,
  Plus,
  Radio,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Ticket,
  TrendingUp,
  UserCog,
  UsersRound,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { PROJECT_STATUS_LABELS, type ProjectStatusValue } from "@support-automation/shared";
import { Badge, ButtonLink, Card, HeroKpi, PageHeader, Sparkline, StatTile, Table, Td, Th } from "@/components/ui";
import { BarList, ChartCard, ChartHeadline, DonutChart, formatCount, Heatmap, StackedBar, TrafficChart } from "@/components/charts";
import { ActionList, ActivityFeed, ChartEmpty, ClosableGuide, GettingStarted, QuickActions, SectionTitle, setupGuideCookie, type ActionItem, type ActivityEntry, type QuickAction, type SetupStep } from "@/components/dashboard";
import { combineKpis, getProjectSummaries, requireMainAdminPage, type ProjectSummary } from "@/server/mainAdmin";
import { getAdminActivity, getAdminInsights, getAdminPeople } from "@/server/mainAdminInsights";
import { getGrantedPermissionKeys } from "@/server/permissions";
import { platformPrisma } from "@/server/db";
import { getBranding } from "@/server/branding";
import { CHANNEL_PRESENTATION } from "@/app/p/[project]/(dashboard)/conversations/ChannelMark";
import { whatsappLine } from "./ProjectCard";
import { WelcomeSetup, type WelcomeStep } from "./WelcomeSetup";

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

/** "5m ago", "3h ago", "2d ago", then the date. */
function ago(at: Date, nowMs: number): string {
  const minutes = Math.max(0, Math.round((nowMs - at.getTime()) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  if (minutes < 10_080) return `${Math.round(minutes / 1440)}d ago`;
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short" }).format(at);
}

/** The project's reading in one word, from the same attention reasons the portal already worked out. */
function healthOf(project: ProjectSummary): { label: string; color: "green" | "yellow" | "red" | "gray" } {
  if (project.status === "SUSPENDED") return { label: "On hold", color: "yellow" };
  if (project.whatsapp.down > 0 || project.whatsapp.needsPerson > 0) return { label: "Connection issue", color: "red" };
  if (project.attention.length > 0) return { label: "Needs attention", color: "yellow" };
  if (project.status === "SETUP") return { label: "Setting up", color: "gray" };
  return { label: "Healthy", color: "green" };
}

const ACTIVITY_ICON: Record<string, LucideIcon> = { projects: FolderKanban, users: UserCog, configuration: Building2, permissions: ShieldCheck, branding: Palette };

/**
 * Main Admin Dashboard (MULTI_PROJECT_PLAN.md §8; the Premium Tide Board, apps/web/DESIGN.md): this customer's
 * own business at a glance, in the order somebody reads it: what needs me, how busy we are, where and when
 * customers write, how the projects are doing, who works here, and what the administrators changed. Figures
 * add up only the projects this person can enter, and every detail stays inside the project. Never billing or
 * plans: those belong to the platform (/platform), not to a customer's Main Admin.
 */
export default async function MainAdminDashboard({ searchParams }: { searchParams: Promise<{ guide?: string }> }) {
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
  const canSeePeople = granted.has("users.view") || granted.has("configuration.view");

  const [insights, people, activity, employeeCount, otherLogins, branding, { productName }] = await Promise.all([
    getAdminInsights(enterable.map((p) => p.id), nowMs),
    canSeePeople ? getAdminPeople(nowMs) : null,
    canManage ? getAdminActivity() : [],
    platformPrisma.employee.count(),
    platformPrisma.user.count({ where: { id: { not: session.userId }, supportOperatorId: null } }),
    platformPrisma.platformBranding.findFirst({ select: { productName: true, accentColor: true, assetVersion: true } }),
    getBranding(),
  ]);

  // The setup steps, ticked from what exists: the welcome screen and the dashboard's guide are one list.
  const firstProject = enterable[0];
  const steps: WelcomeStep[] = [
    { key: "project", required: true, title: "Create your first project", detail: "Pick your business type and the modules come ready.", done: listed.length > 0, href: canManage ? "/admin/projects/new" : undefined, action: "Create project" },
    {
      key: "channel",
      required: false,
      title: "Connect WhatsApp or another channel",
      detail: "Link the number or page your customers message.",
      done: kpis.whatsappTotal > 0 || insights.workload.channelConnections > 0,
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

  const channelSlices = insights.channels.map((c) => {
    const known = CHANNEL_PRESENTATION[c.key as keyof typeof CHANNEL_PRESENTATION];
    return { key: c.key, label: known?.short ?? c.key, value: c.value, color: known?.tint ?? "var(--chart-1)" };
  });
  const aiTotal = insights.ai.answered + insights.ai.handedOver;
  const change = insights.totals.previousIncoming > 0 ? Math.round(((insights.totals.incoming - insights.totals.previousIncoming) / insights.totals.previousIncoming) * 100) : null;
  const coverage = people && people.employees > 0 ? Math.round((people.employeesWithLogin / people.employees) * 100) : null;

  const quickActions: QuickAction[] = [
    ...(canManage ? [{ label: "Create a project", href: "/admin/projects/new", icon: Plus }] : []),
    ...(granted.has("configuration.manage") ? [{ label: "Add an employee", href: "/admin/configuration/employees/new", icon: UsersRound }] : []),
    ...(granted.has("users.create") ? [{ label: "Give app access", href: "/admin/users/new", icon: KeyRound }] : []),
    { label: "All projects", href: "/admin/projects", icon: FolderKanban },
    ...(granted.has("configuration.view") ? [{ label: "Organization", href: "/admin/configuration", icon: Building2 }] : []),
    ...(granted.has("users.view") ? [{ label: "Users & access", href: "/admin/users", icon: ShieldCheck }] : []),
    { label: "Branding", href: "/admin/branding", icon: Palette },
    { label: "Project templates", href: "/admin/module-templates", icon: Blocks },
  ];

  // The setup guide: closed by this person stays closed, until they ask for it from Quick actions.
  const guideCookie = setupGuideCookie("admin", session.userId);
  const guideClosed = (await cookies()).get(guideCookie)?.value === "1" && (await searchParams).guide !== "1";
  const guideUnfinished = setup.some((step) => !step.done);
  if (guideClosed && guideUnfinished) quickActions.push({ label: "Setup guide", href: "/admin?guide=1", icon: ListChecks });

  const activityEntries: ActivityEntry[] = activity.map((row) => ({
    key: row.id,
    icon: ACTIVITY_ICON[row.scope] ?? History,
    tint: row.warn ? "warning" : "accent",
    title: row.message,
    detail: row.actor ? `by ${row.actor}` : undefined,
    time: ago(row.createdAt, nowMs),
  }));

  const today = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", weekday: "long", day: "numeric", month: "long" }).format(new Date(nowMs));
  const description =
    needsAttention.length > 0
      ? `${today}. ${needsAttention.length} project${needsAttention.length === 1 ? " needs" : "s need"} attention. Figures add up the ${kpis.projects} project${kpis.projects === 1 ? "" : "s"} you can enter${kpis.excludedProjects > 0 ? `; ${kpis.excludedProjects} more ${kpis.excludedProjects === 1 ? "is" : "are"} listed without access` : ""}.`
      : `${today}. Every project is healthy. Figures add up the ${kpis.projects} project${kpis.projects === 1 ? "" : "s"} you can enter${kpis.excludedProjects > 0 ? `; ${kpis.excludedProjects} more ${kpis.excludedProjects === 1 ? "is" : "are"} listed without access` : ""}.`;

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
        <HeroKpi tone="tide" icon={Layers} label="Projects" value={formatCount(listed.length)} href="/admin/projects" sub={`${count("ACTIVE")} active, ${count("SETUP")} in setup${count("SUSPENDED") ? `, ${count("SUSPENDED")} on hold` : ""}`} />
        <HeroKpi
          tone="navy"
          icon={MessagesSquare}
          label="Messages today"
          value={formatCount(kpis.messagesToday)}
          sub="Across your projects, since midnight"
          spark={insights.traffic.map((d) => d.incoming)}
          sparkLabel="Incoming messages per day across your projects, last 14 days"
        />
        <HeroKpi
          tone="sea"
          icon={Smartphone}
          label="WhatsApp connected"
          value={`${formatCount(kpis.whatsappConnected)}/${formatCount(kpis.whatsappTotal)}`}
          sub={kpis.whatsappTotal === 0 ? "No number linked yet" : kpis.whatsappNeedsAttention > 0 ? `${kpis.whatsappNeedsAttention} need attention` : "All numbers online"}
        />
        <HeroKpi tone={needsAttention.length > 0 ? "amber" : "tide"} icon={needsAttention.length > 0 ? AlertTriangle : CheckCircle2} label="Needing attention" value={formatCount(needsAttention.length)} sub={needsAttention.length > 0 ? (needsAttention[0]?.name ?? "") : `${listed.length} of ${listed.length} healthy`} />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatTile icon={Bot} label="AI answers today" value={formatCount(kpis.aiRepliesToday)} tone="accent" />
        <StatTile icon={Activity} label="Support activity today" value={formatCount(kpis.supportActivityToday)} />
        <StatTile icon={ShieldAlert} label="Open escalations" value={formatCount(kpis.openEscalations)} tone={kpis.openEscalations > 0 ? "warning" : "neutral"} />
        <StatTile icon={Ticket} label="Open tickets" value={formatCount(insights.workload.openTickets)} tone={insights.workload.openTickets > 0 ? "accent" : "neutral"} />
        <StatTile icon={AlarmClock} label="Follow-ups due" value={formatCount(insights.workload.followUpsDue)} tone={insights.workload.followUpsDue > 0 ? "warning" : "neutral"} />
        <StatTile icon={PlugZap} label="Other channels connected" value={formatCount(insights.workload.channelConnections)} />
      </div>

      <SectionTitle title="Conversations" hint="Messages across the projects you can enter." />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <ChartCard
          className="xl:col-span-8"
          icon={TrendingUp}
          title="Messages in and out"
          description="What customers sent and what went back, per day, last 14 days."
          headline={
            <ChartHeadline
              value={formatCount(insights.totals.incoming)}
              caption="received"
              delta={change === null ? undefined : `${change > 0 ? "+" : ""}${change}% vs the 14 days before`}
              deltaTone={change === null || change === 0 ? "neutral" : change > 0 ? "up" : "down"}
            />
          }
        >
          {insights.totals.incoming + insights.totals.outgoing === 0 ? (
            <ChartEmpty text="No messages yet. They start counting once a project has a connected number or channel." />
          ) : (
            <TrafficChart data={insights.traffic} ariaLabel="Messages received and sent per day across your projects, last 14 days" />
          )}
        </ChartCard>
        <ChartCard className="xl:col-span-4" icon={Radio} title="Where customers write" description="Messages received per channel, last 14 days.">
          {channelSlices.length === 0 ? (
            <ChartEmpty text="No messages received in the last 14 days." />
          ) : (
            <DonutChart slices={channelSlices} total={insights.totals.incoming} centerLabel="received" ariaLabel="Messages received per channel, last 14 days" />
          )}
        </ChartCard>

        <ChartCard className="xl:col-span-8" icon={CalendarClock} title="When customers write" description="Messages received by weekday and hour (Dhaka time), last 4 weeks. Darker means busier.">
          {insights.heatTotal === 0 ? <ChartEmpty text="No messages in the last 4 weeks yet." /> : <Heatmap grid={insights.heat} unitLabel="messages" ariaLabel="Messages received by weekday and hour, last 4 weeks" />}
        </ChartCard>
        <ChartCard className="xl:col-span-4" icon={Sparkles} title="AI and your team" description="Questions the rules did not cover, last 14 days." headline={aiTotal > 0 ? <ChartHeadline value={`${Math.round((insights.ai.answered / aiTotal) * 100)}%`} caption="answered by AI" /> : undefined}>
          {aiTotal === 0 ? (
            <ChartEmpty text="Nothing reached the AI in the last 14 days. It answers once AI is switched on in a project." />
          ) : (
            <StackedBar
              total={aiTotal}
              ariaLabel="Questions answered by AI and handed to the team, last 14 days"
              segments={[
                { key: "ai", label: "Answered by AI", value: insights.ai.answered, color: "var(--chart-1)" },
                { key: "team", label: "Handed to the team", value: insights.ai.handedOver, color: "var(--chart-2)" },
              ]}
            />
          )}
        </ChartCard>
      </div>

      <SectionTitle title="Projects" hint="Each one is its own business or team." />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <section className="min-w-0 xl:col-span-8" aria-label="Projects">
          <Card className="h-full !p-0">
            <div className="flex items-center justify-between gap-3 px-5 pb-2.5 pt-4">
              <h3 className="flex items-center gap-2 text-[14.5px] font-semibold tracking-[-0.01em] text-[color:var(--color-foreground)]">
                <FolderKanban className="size-[18px] text-[color:var(--color-accent)]" aria-hidden />
                Your projects
              </h3>
              <NextLink href="/admin/projects" className="inline-flex items-center gap-1 text-[12.5px] font-medium text-[color:var(--color-accent-fg)] hover:underline">
                View all
                <ArrowRight className="size-3.5" aria-hidden />
              </NextLink>
            </div>
            <div className="px-2 pb-2">
              <Table>
                <thead>
                  <tr>
                    <Th>Project</Th>
                    <Th>Health</Th>
                    <Th>Today · 14-day trend</Th>
                    <Th>
                      <span className="sr-only">Actions</span>
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {ordered.map((project) => {
                    const wa = whatsappLine(project.whatsapp);
                    const health = healthOf(project);
                    const trend = insights.perProject[project.id] ?? [];
                    return (
                      <tr key={project.id}>
                        <Td>
                          <div className="flex items-center gap-2.5">
                            <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-accent-bg)] text-[12px] font-semibold text-[color:var(--color-accent-fg)]">
                              {project.name.trim().charAt(0).toUpperCase()}
                            </span>
                            <span className="min-w-0">
                              <NextLink href={`/admin/projects/${project.id}`} className="block max-w-[18rem] truncate font-medium text-[color:var(--color-foreground)] hover:underline">
                                {project.name}
                              </NextLink>
                              <span className="block max-w-[18rem] truncate text-[11.5px] text-[color:var(--color-muted-foreground)]">
                                WhatsApp: {wa.text.toLowerCase()} · {project.usersWithAccess} with access
                              </span>
                            </span>
                          </div>
                        </Td>
                        <Td>
                          <Badge color={health.color} dot>
                            {health.label}
                          </Badge>
                        </Td>
                        <Td>
                          <div className="flex items-center gap-3">
                            <span className="tabular w-10 shrink-0 font-medium text-[color:var(--color-foreground)]">{project.messagesToday.toLocaleString()}</span>
                            {project.canEnter && trend.some((n) => n > 0) ? (
                              <div className="w-20 shrink-0">
                                <Sparkline data={trend} height={24} strokeColor="var(--chart-1)" fillColor="var(--chart-1)" ariaLabel={`${project.name}: messages received per day, last 14 days`} />
                              </div>
                            ) : (
                              <span className="text-[12px] text-[color:var(--color-subtle-foreground)]">No recent messages</span>
                            )}
                          </div>
                        </Td>
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
          </Card>
        </section>
        <div className="flex flex-col gap-4 xl:col-span-4">
          <ActionList items={actions.slice(0, 4)} hiddenCount={Math.max(0, actions.length - 4)} emptyText="A project with a connection problem or an unfinished setup appears here." />
          <ChartCard className="flex-1" icon={HeartPulse} title="Projects by status">
            <DonutChart slices={statusSlices} total={projects.length} centerLabel="projects" ariaLabel="Projects by status" />
          </ChartCard>
        </div>
        <ChartCard className="xl:col-span-6" icon={Zap} title="Busiest today" description="Messages per project, since midnight.">
          <BarList items={[...enterable].sort((a, b) => b.messagesToday - a.messagesToday).filter((p) => p.messagesToday > 0).slice(0, 6).map((p) => ({ id: p.id, label: p.name, value: p.messagesToday }))} emptyMessage="No messages today yet." />
        </ChartCard>
        <ChartCard className="xl:col-span-6" icon={UsersRound} title="Customer records" description="Kept across your projects.">
          <dl className="grid grid-cols-2 gap-3">
            {[
              { label: "Clients", value: insights.workload.clients },
              { label: "Contacts", value: insights.workload.contacts },
              { label: "Monitored groups", value: kpis.monitoredGroups },
              { label: "Team members", value: kpis.activeTeamMembers },
            ].map((f) => (
              <div key={f.label} className="rounded-[var(--radius-lg)] bg-[var(--color-surface-sunken)] px-4 py-3">
                <dt className="text-[12px] text-[color:var(--color-muted-foreground)]">{f.label}</dt>
                <dd className="tabular mt-0.5 text-[22px] font-semibold tracking-[-0.02em] text-[color:var(--color-foreground)]">{formatCount(f.value)}</dd>
              </div>
            ))}
          </dl>
        </ChartCard>
      </div>

      {people ? (
        <>
          <SectionTitle title="People and access" hint="Who works here and who can sign in." />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <ChartCard icon={KeyRound} title="App access" description="Employees who have a login.">
              <div className="flex items-end justify-between gap-3">
                <p className="tabular text-[30px] font-semibold leading-none tracking-[-0.02em] text-[color:var(--color-foreground)]">
                  {coverage === null ? "—" : `${coverage}%`}
                </p>
                <p className="text-right text-[12.5px] text-[color:var(--color-muted-foreground)]">
                  {people.employeesWithLogin} of {people.employees} employees
                </p>
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--color-neutral-bg)]" role="progressbar" aria-valuenow={coverage ?? 0} aria-valuemin={0} aria-valuemax={100} aria-label="Employees with a login">
                <div className="h-full rounded-full bg-[var(--color-accent)]" style={{ width: `${coverage ?? 0}%` }} />
              </div>
              <dl className="mt-4 grid grid-cols-3 gap-2 text-center">
                {[
                  { label: "Logins", value: people.activeLogins },
                  { label: "Signed in this week", value: people.signedInThisWeek },
                  { label: "Deactivated", value: people.logins - people.activeLogins },
                ].map((f) => (
                  <div key={f.label} className="rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] px-2 py-2">
                    <dd className="tabular text-[17px] font-semibold text-[color:var(--color-foreground)]">{formatCount(f.value)}</dd>
                    <dt className="text-[11px] leading-tight text-[color:var(--color-muted-foreground)]">{f.label}</dt>
                  </div>
                ))}
              </dl>
              {people.employees > people.employeesWithLogin && granted.has("configuration.view") ? (
                <NextLink href="/admin/configuration/employees" className="mt-3 inline-flex items-center gap-1 text-[12.5px] font-medium text-[color:var(--color-accent-fg)] hover:underline">
                  {people.employees - people.employeesWithLogin} without access
                  <ArrowRight className="size-3.5" aria-hidden />
                </NextLink>
              ) : null}
            </ChartCard>
            <ChartCard icon={ShieldCheck} title="Logins by role" description="Active logins on each role.">
              <BarList items={people.byRole.slice(0, 6)} unitLabel="logins" emptyMessage="No logins yet." />
            </ChartCard>
            <ChartCard icon={Building2} title="Employees by department" description="Active employees.">
              <BarList items={people.byDepartment.slice(0, 6)} unitLabel="employees" emptyMessage="No employees yet. Add them under Organization." />
            </ChartCard>
          </div>
        </>
      ) : null}

      <SectionTitle title="Administration" />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        {canManage ? (
          <div className="xl:col-span-7">
            <ActivityFeed title="Recent changes" icon={History} entries={activityEntries} emptyText="Changes to projects, people and roles appear here as they happen." />
          </div>
        ) : null}
        <div className={canManage ? "xl:col-span-5" : "xl:col-span-12"}>
          <QuickActions icon={Zap} actions={quickActions} />
        </div>
      </div>
    </div>
  );
}
