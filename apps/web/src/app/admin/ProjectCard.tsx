import { ArrowRight, Settings2 } from "lucide-react";
import { Badge, ButtonLink } from "@/components/ui";
import { ProjectStatusBadge } from "@/components/ProjectSwitcher";
import type { ProjectSummary } from "@/server/mainAdmin";

/** "WhatsApp: Connected" / "2 of 3 connected" / "Not linked" — the one line that says whether it can work. */
export function whatsappLine(whatsapp: ProjectSummary["whatsapp"]): { text: string; color: "green" | "yellow" | "red" | "gray" } {
  if (whatsapp.total === 0) return { text: "No account linked", color: "gray" };
  if (whatsapp.connected === whatsapp.total) return { text: whatsapp.total === 1 ? "Connected" : `${whatsapp.total} connected`, color: "green" };
  if (whatsapp.connected === 0) return { text: "Not connected", color: "red" };
  return { text: `${whatsapp.connected} of ${whatsapp.total} connected`, color: "yellow" };
}

/**
 * One project, as the Main Admin Portal lists it (MULTI_PROJECT_PLAN.md §8). Counts only — nothing
 * inside the project is shown here. "Open project" goes into that project's existing Overview.
 */
export function ProjectCard({ project }: { project: ProjectSummary }) {
  const wa = whatsappLine(project.whatsapp);
  return (
    <article className="flex flex-col rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-[var(--shadow-xs),var(--highlight-top)]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold tracking-[-0.01em] text-[color:var(--color-foreground)]">{project.name}</h2>
          <p className="mt-0.5 font-mono text-xs text-[color:var(--color-muted-foreground)]">/p/{project.slug}</p>
        </div>
        <ProjectStatusBadge status={project.status} />
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2.5 text-[13px]">
        <div className="col-span-2 flex items-center justify-between gap-2">
          <dt className="text-[color:var(--color-muted-foreground)]">WhatsApp</dt>
          <dd>
            <Badge color={wa.color} dot>
              {wa.text}
            </Badge>
          </dd>
        </div>
        <Figure label="Monitored groups" value={project.monitoredGroups} />
        <Figure label="Team members" value={project.teamMembers} />
        <Figure label="Messages today" value={project.messagesToday} />
        <Figure label="Open escalations" value={project.openEscalations} />
      </dl>

      {project.attention.length > 0 ? (
        <ul className="mt-4 space-y-1 rounded-[var(--radius-md)] border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] px-3 py-2 text-xs text-[color:var(--color-warning-fg)]">
          {project.attention.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}

      <div className="mt-5 flex flex-wrap items-center gap-2 pt-1">
        {project.canEnter ? (
          <ButtonLink href={`/p/${project.slug}/overview`} variant="primary">
            Open project
            <ArrowRight className="size-3.5" aria-hidden />
          </ButtonLink>
        ) : (
          <span className="text-xs text-[color:var(--color-muted-foreground)]">You do not have access to enter this project.</span>
        )}
        <ButtonLink href={`/admin/projects/${project.id}`}>
          <Settings2 className="size-3.5" aria-hidden />
          Manage
        </ButtonLink>
      </div>
    </article>
  );
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-[color:var(--color-muted-foreground)]">{label}</dt>
      <dd className="tabular font-medium text-[color:var(--color-foreground)]">{value.toLocaleString()}</dd>
    </div>
  );
}
