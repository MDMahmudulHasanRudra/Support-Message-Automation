import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSession } from "@/server/auth";
import { accessibleProjects } from "@/server/projectContext";
import { LAST_PROJECT_COOKIE } from "@/lib/projectPaths";

/**
 * Where a URL without a project lands: sign-in, a bookmark from before multi-project, the root.
 * Picks a project the user can enter — the one they last opened if they still have access to it,
 * otherwise the oldest — and continues to the requested page inside it. A page rather than a route
 * handler so the client router follows the redirect like any other navigation. There is no project
 * switcher yet (Phase 4); a user with no project access is told so rather than sent round in a loop.
 */
export default async function OpenProject({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const session = await getSession();
  if (!session) redirect("/login");

  const rawNext = (await searchParams).next ?? "/overview";
  // Same-origin, project-relative paths only — never "//evil.example" or a full URL.
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//") && !rawNext.startsWith("/p/") && rawNext !== "/" ? rawNext : "/overview";

  const projects = await accessibleProjects(session.userId);
  if (projects.length === 0) {
    return (
      <main className="mx-auto max-w-md px-6 py-24 text-center">
        <h1 className="text-xl font-semibold text-[color:var(--color-foreground)]">No project access</h1>
        <p className="mt-3 text-sm text-[color:var(--color-muted-foreground)]">
          Your account does not have access to any project yet. Ask an administrator to give you access.
        </p>
      </main>
    );
  }
  const last = (await cookies()).get(LAST_PROJECT_COOKIE)?.value;
  const project = projects.find((p) => p.slug === last) ?? projects[0]!;
  redirect(`/p/${project.slug}${next}`);
}
