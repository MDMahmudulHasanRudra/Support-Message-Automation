import { AlertTriangle, ArrowRight, Bot, MessagesSquare, Settings2, ShieldAlert, Smartphone, Users, UsersRound } from "lucide-react";
import type { LucideIcon } from "lucide-react";
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
  const held = project.status !== "ACTIVE";
  return (
    <article className="group flex flex-col overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xs),var(--highlight-top)] transition-[box-shadow,border-color,transform] duration-[var(--duration-base)] ease-[var(--ease-out)] hover:-translate-y-px hover:border-[var(--color-border-strong)] hover:shadow-[var(--shadow-md)]">
      <div className="tide-field relative flex items-center gap-3 bg-[var(--tide-bg)] px-5 py-4">
        <span
          aria-hidden
          className={`flex size-11 shrink-0 items-center justify-center rounded-[var(--radius-lg)] text-[17px] font-semibold ${held ? "bg-white/10 text-white/70" : "bg-[var(--tide-mark)] text-[var(--tide-bg)]"}`}
        >
          {project.name.trim().charAt(0).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15.5px] font-semibold tracking-[-0.01em] text-[color:var(--color-foreground)]">{project.name}</h2>
          <p className="mt-0.5 truncate font-mono text-[11.5px] text-[color:var(--color-muted-foreground)]">/p/{project.slug}</p>
        </div>
        <ProjectStatusBadge status={project.status} />
      </div>

      <div className="flex flex-1 flex-col p-5">
        <dl className="grid grid-cols-2 gap-2.5">
          <Figure icon={MessagesSquare} label="Messages today" value={project.messagesToday} />
          <Figure icon={Bot} label="AI answers today" value={project.aiRepliesToday} />
          <Figure icon={Users} label="Team members" value={project.teamMembers} />
          <Figure icon={ShieldAlert} label="Open escalations" value={project.openEscalations} warn={project.openEscalations > 0} />
        </dl>

        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-[12.5px] text-[color:var(--color-muted-foreground)]">
          <span className="inline-flex items-center gap-1.5">
            <Smartphone className="size-3.5" aria-hidden />
            WhatsApp
            <Badge color={wa.color} dot>
              {wa.text}
            </Badge>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <UsersRound className="size-3.5" aria-hidden />
            {project.usersWithAccess.toLocaleString()} {project.usersWithAccess === 1 ? "person has" : "people have"} access
          </span>
        </div>

        {project.attention.length > 0 ? (
          <ul className="mt-4 space-y-1 rounded-[var(--radius-md)] border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] px-3 py-2 text-xs text-[color:var(--color-warning-fg)]">
            {project.attention.map((line) => (
              <li key={line} className="flex gap-1.5">
                <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
                {line}
              </li>
            ))}
          </ul>
        ) : null}

        <div className="mt-auto flex flex-wrap items-center gap-2 pt-5">
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
      </div>
    </article>
  );
}

function Figure({ icon: Icon, label, value, warn = false }: { icon: LucideIcon; label: string; value: number; warn?: boolean }) {
  return (
    <div className="rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] px-3 py-2.5">
      <dt className="flex items-center gap-1.5 text-[11.5px] text-[color:var(--color-muted-foreground)]">
        <Icon className={`size-3.5 ${warn ? "text-[color:var(--color-warning)]" : "text-[color:var(--color-accent)]"}`} aria-hidden />
        {label}
      </dt>
      <dd className={`tabular mt-0.5 text-[20px] font-semibold leading-tight tracking-[-0.02em] ${warn ? "text-[color:var(--color-warning-fg)]" : "text-[color:var(--color-foreground)]"}`}>
        {value.toLocaleString()}
      </dd>
    </div>
  );
}
