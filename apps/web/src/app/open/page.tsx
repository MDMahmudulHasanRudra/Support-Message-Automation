import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import NextLink from "next/link";
import { ArrowRight, FolderPlus, LayoutDashboard, UserRound } from "lucide-react";
import { getSession } from "@/server/auth";
import { accessibleProjects } from "@/server/projectContext";
import { LAST_PROJECT_COOKIE } from "@/lib/projectPaths";
import { hasPermission } from "@/server/permissions";
import { getBranding } from "@/server/branding";
import { BrandMark } from "@/components/ui";
import { ProjectStatusBadge } from "@/components/ProjectSwitcher";

/**
 * Where a URL without a project lands: sign-in, a bookmark from before multi-project, the root.
 * Continues into the project last opened if the user still has access to it, or the only one they have.
 * Somebody with several projects and none opened yet chooses, rather than being dropped into the oldest.
 * A user with no project is told so rather than sent round in a loop, and offered the Main Admin Portal
 * if they may see it. A page rather than a route handler so the client router follows the redirect.
 */
export default async function OpenProject({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const session = await getSession();
  if (!session) redirect("/login");

  const rawNext = (await searchParams).next ?? "/overview";
  // Same-origin, project-relative paths only — never "//evil.example" or a full URL.
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//") && !rawNext.startsWith("/p/") && rawNext !== "/" ? rawNext : "/overview";

  const projects = await accessibleProjects(session.userId);
  const last = (await cookies()).get(LAST_PROJECT_COOKIE)?.value;
  const lastProject = projects.find((p) => p.slug === last);
  // A deep link names a page, so it still goes straight there.
  if (lastProject || projects.length === 1 || (projects.length > 1 && next !== "/overview")) {
    redirect(`/p/${(lastProject ?? projects[0]!).slug}${next}`);
  }

  const [canViewAdmin, canManage, { productName }] = await Promise.all([hasPermission(session, "projects.view"), hasPermission(session, "projects.manage"), getBranding()]);

  return (
    <main className="tide-field flex min-h-screen flex-col items-center bg-[var(--tide-bg)] px-4 pb-16 pt-14 text-[color:var(--color-foreground)]">
      <div className="flex items-center gap-2.5">
        <BrandMark className="size-9" />
        <span className="text-[17px] font-semibold tracking-[-0.01em]">{productName}</span>
      </div>
      <h1 className="mt-8 text-center text-[24px] font-semibold tracking-[-0.02em]">{projects.length > 0 ? `Welcome, ${session.username}` : "No project yet"}</h1>
      <p className="mt-2 max-w-md text-center text-[14px] leading-relaxed text-[color:var(--color-muted-foreground)]">
        {projects.length > 0
          ? "Choose where to start. You can switch project any time from the top of the screen."
          : canManage
            ? "Create your first project to connect a WhatsApp number and bring your team in."
            : "Your account does not have access to any project yet. Ask an administrator to give you access."}
      </p>

      <div className="mt-8 w-full max-w-lg space-y-2">
        {projects.map((project) => (
          <NextLink
            key={project.slug}
            href={`/p/${project.slug}/overview`}
            className="group flex items-center gap-3 rounded-[var(--radius-lg)] bg-[var(--color-surface)] p-3.5 ring-1 ring-inset ring-[var(--color-border)] transition-colors hover:bg-[var(--color-surface-raised)] hover:ring-[var(--color-border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
          >
            <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--tide-active)] text-[14px] font-semibold text-white">
              {project.name.trim().charAt(0).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-medium">{project.name}</span>
              <span className="block truncate text-[12px] text-[color:var(--color-muted-foreground)]">/p/{project.slug}</span>
            </span>
            <ProjectStatusBadge status={project.status} />
            <ArrowRight className="size-4 shrink-0 text-[color:var(--color-muted-foreground)] transition-transform group-hover:translate-x-0.5" aria-hidden />
          </NextLink>
        ))}

        {canManage && projects.length === 0 ? (
          <NextLink href="/admin/projects/new" className="flex items-center justify-center gap-2 rounded-[var(--radius-lg)] bg-[var(--marigold)] p-3.5 text-[14px] font-semibold text-[#2c1c02] transition-[filter] hover:brightness-105">
            <FolderPlus className="size-4" aria-hidden />
            Create your first project
          </NextLink>
        ) : null}

        {canViewAdmin ? (
          <NextLink href="/admin" className="flex items-center gap-3 rounded-[var(--radius-lg)] p-3.5 text-[13.5px] font-medium ring-1 ring-inset ring-[var(--color-border)] transition-colors hover:bg-white/[0.06]">
            <LayoutDashboard className="size-4 shrink-0" aria-hidden />
            <span className="flex-1">Main Admin Portal</span>
            <span className="text-[12px] font-normal text-[color:var(--color-muted-foreground)]">Projects, users, branding</span>
          </NextLink>
        ) : null}
        <NextLink href="/account" className="flex items-center justify-center gap-2 p-2 text-[13px] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]">
          <UserRound className="size-3.5" aria-hidden />
          My account
        </NextLink>
      </div>
    </main>
  );
}
