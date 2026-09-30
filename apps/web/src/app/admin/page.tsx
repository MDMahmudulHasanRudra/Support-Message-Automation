import NextLink from "next/link";
import { Plus } from "lucide-react";
import { PROJECT_STATUS_LABELS, type ProjectStatusValue } from "@support-automation/shared";
import { Alert, Badge, ButtonLink, PageHeader, SectionHeader, StatTile, Table, Td, Th } from "@/components/ui";
import { ProjectStatusBadge } from "@/components/ProjectSwitcher";
import { combineKpis, getProjectSummaries, requireMainAdminPage } from "@/server/mainAdmin";
import { whatsappLine } from "./ProjectCard";

export const metadata = { title: "Overview" };

/**
 * Main Admin Overview (MULTI_PROJECT_PLAN.md §8). Intentionally high-level: how many projects, in
 * which state, whether each one's WhatsApp is working, and a few counts. Every detailed figure is a
 * project's own report, inside the project.
 */
export default async function MainAdminOverview() {
  const { session, canManage } = await requireMainAdminPage();
  const projects = await getProjectSummaries(session.userId, { includeArchived: true });
  const count = (status: ProjectStatusValue) => projects.filter((p) => p.status === status).length;
  const needsAttention = projects.filter((p) => p.status !== "ARCHIVED" && p.attention.length > 0);
  const listed = projects.filter((p) => p.status !== "ARCHIVED");
  const kpis = combineKpis(projects);

  return (
    <div>
      <PageHeader
        title="Main Admin"
        description="Every project on this Softify Assist installation. Open a project to work in it; its own pages and reports are where the detail lives."
        actions={
          canManage ? (
            <ButtonLink href="/admin/projects/new" variant="primary">
              <Plus className="size-4" aria-hidden />
              Create project
            </ButtonLink>
          ) : null
        }
      />

      <div className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile label="Projects" value={projects.length} href="/admin/projects" />
        <StatTile label={PROJECT_STATUS_LABELS.ACTIVE} value={count("ACTIVE")} tone={count("ACTIVE") > 0 ? "success" : "neutral"} />
        <StatTile label={PROJECT_STATUS_LABELS.SETUP} value={count("SETUP")} />
        <StatTile label={PROJECT_STATUS_LABELS.SUSPENDED} value={count("SUSPENDED")} tone={count("SUSPENDED") > 0 ? "warning" : "neutral"} />
        <StatTile label={PROJECT_STATUS_LABELS.ARCHIVED} value={count("ARCHIVED")} href="/admin/projects?archived=1" />
      </div>

      <SectionHeader
        title="Across your projects"
        description={`Today, added up over the ${kpis.projects} project${kpis.projects === 1 ? "" : "s"} you can enter${
          kpis.excludedProjects > 0 ? ` — ${kpis.excludedProjects} listed project${kpis.excludedProjects === 1 ? " is" : "s are"} left out because you cannot enter ${kpis.excludedProjects === 1 ? "it" : "them"}` : ""
        }. Each figure is the same count the project's own pages show.`}
      />
      <div className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4" data-kpis>
        <StatTile
          label="WhatsApp connected"
          value={`${kpis.whatsappConnected} / ${kpis.whatsappTotal}`}
          tone={kpis.whatsappNeedsAttention > 0 ? "warning" : kpis.whatsappTotal > 0 ? "success" : "neutral"}
          hint={kpis.whatsappNeedsAttention > 0 ? `${kpis.whatsappNeedsAttention} need attention` : undefined}
        />
        <StatTile label="Messages today" value={kpis.messagesToday.toLocaleString()} />
        <StatTile label="Open escalations" value={kpis.openEscalations.toLocaleString()} tone={kpis.openEscalations > 0 ? "warning" : "neutral"} />
        <StatTile label="Support activity today" value={kpis.supportActivityToday.toLocaleString()} />
        <StatTile label="AI answers today" value={kpis.aiRepliesToday.toLocaleString()} />
        <StatTile label="Monitored groups" value={kpis.monitoredGroups.toLocaleString()} />
        <StatTile label="Active team members" value={kpis.activeTeamMembers.toLocaleString()} />
        <StatTile label="Projects you can enter" value={kpis.projects} />
      </div>

      {needsAttention.length > 0 ? (
        <div className="mb-8 space-y-2">
          {needsAttention.map((project) => (
            <Alert key={project.id} tone="warning" title={project.name}>
              {project.attention.join(" ")}{" "}
              <NextLink href={`/admin/projects/${project.id}`} className="font-medium underline">
                Manage
              </NextLink>
            </Alert>
          ))}
        </div>
      ) : null}

      <SectionHeader title="Projects" description="Archived projects are left out here; see Projects to include them." />
      <Table>
        <thead>
          <tr>
            <Th>Project</Th>
            <Th>Status</Th>
            <Th>WhatsApp</Th>
            <Th>Monitored groups</Th>
            <Th>Messages today</Th>
            <Th>Open escalations</Th>
            <Th>Users with access</Th>
            <Th> </Th>
          </tr>
        </thead>
        <tbody>
          {listed.map((project) => {
            const wa = whatsappLine(project.whatsapp);
            return (
              <tr key={project.id}>
                <Td>
                  <NextLink href={`/admin/projects/${project.id}`} className="font-medium text-[color:var(--color-foreground)] hover:underline">
                    {project.name}
                  </NextLink>
                  <div className="font-mono text-xs text-[color:var(--color-muted-foreground)]">/p/{project.slug}</div>
                </Td>
                <Td>
                  <ProjectStatusBadge status={project.status} />
                </Td>
                <Td>
                  <Badge color={wa.color} dot>
                    {wa.text}
                  </Badge>
                </Td>
                <Td className="tabular">{project.monitoredGroups.toLocaleString()}</Td>
                <Td className="tabular">{project.messagesToday.toLocaleString()}</Td>
                <Td className="tabular">{project.openEscalations.toLocaleString()}</Td>
                <Td className="tabular">{project.usersWithAccess.toLocaleString()}</Td>
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
  );
}
