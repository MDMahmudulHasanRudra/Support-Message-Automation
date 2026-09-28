import { AsyncLocalStorage } from "node:async_hooks";
import { headers } from "next/headers";
import { prisma as platformPrisma, ProjectScopeError } from "@support-automation/db";
import { PROJECT_HEADER } from "@/lib/projectPaths";
import { getSession } from "@/server/auth";

/**
 * The active project for this request, and whether the signed-in user may be in it.
 *
 * The project comes from the URL and only from the URL: `proxy.ts` reads `/p/<slug>/…` and
 * forwards the slug in a request header it always overwrites, so a client cannot supply its own.
 * Server Actions POST to the page's own URL, so a write carries the project of the tab it came
 * from — never a cookie shared across tabs (MULTI_PROJECT_PLAN.md §4.1).
 *
 * This answers ONE question, "may this user enter this project?" (`ProjectAccess`). What they may
 * do inside it is the existing permission system, checked afterwards and unchanged
 * (`server/authorize.ts`). The two are deliberately separate.
 */

export interface ActiveProject {
  id: string;
  slug: string;
  name: string;
}

export type ProjectAccessFailure = "NO_PROJECT_IN_URL" | "NO_SESSION" | "UNKNOWN_PROJECT" | "NO_ACCESS";

export class ProjectAccessError extends ProjectScopeError {
  constructor(readonly reason: ProjectAccessFailure) {
    super(
      reason === "NO_PROJECT_IN_URL"
        ? "This request has no project in its URL."
        : reason === "NO_SESSION"
          ? "Sign in to continue."
          : "You do not have access to this project.",
    );
    this.name = "ProjectAccessError";
  }
}

/**
 * Work that runs after the response — `after()` in a page — has no request headers to read. The
 * caller has already resolved (and authorized) the project, so it hands the result in explicitly.
 */
const explicitProject = new AsyncLocalStorage<ActiveProject>();
export function runWithProject<T>(project: ActiveProject, fn: () => T): T {
  return explicitProject.run(project, fn);
}

export async function activeProjectSlug(): Promise<string | null> {
  const explicit = explicitProject.getStore();
  if (explicit) return explicit.slug;
  try {
    return (await headers()).get(PROJECT_HEADER);
  } catch {
    return null; // outside a request (build, instrumentation): there is no project
  }
}

/**
 * Access decisions, cached for a few seconds per user and project. Every Prisma query on a
 * project-owned table asks for the project, and a page issues dozens; without this each would
 * cost two extra lookups. The cost is that a revoked access takes up to this long to bite.
 */
const ACCESS_TTL_MS = 5_000;
const accessCache = new Map<string, { at: number; project: ActiveProject | null; reason?: ProjectAccessFailure }>();

async function decideAccess(userId: string, slug: string): Promise<{ project: ActiveProject | null; reason?: ProjectAccessFailure }> {
  const key = `${userId} ${slug}`;
  const cached = accessCache.get(key);
  if (cached && Date.now() - cached.at < ACCESS_TTL_MS) return cached;

  const project = await platformPrisma.project.findUnique({ where: { slug }, select: { id: true, slug: true, name: true } });
  let decision: { project: ActiveProject | null; reason?: ProjectAccessFailure };
  if (!project) {
    decision = { project: null, reason: "UNKNOWN_PROJECT" };
  } else {
    const access = await platformPrisma.projectAccess.findUnique({
      where: { projectId_userId: { projectId: project.id, userId } },
      select: { id: true },
    });
    decision = access ? { project } : { project: null, reason: "NO_ACCESS" };
  }
  if (accessCache.size > 5_000) accessCache.clear();
  accessCache.set(key, { at: Date.now(), ...decision });
  return decision;
}

/** The active project, or a `ProjectAccessError` — never a guess, never "all projects". */
export async function requireActiveProject(): Promise<ActiveProject> {
  const explicit = explicitProject.getStore();
  if (explicit) return explicit;
  const slug = await activeProjectSlug();
  if (!slug) throw new ProjectAccessError("NO_PROJECT_IN_URL");
  const session = await getSession();
  if (!session) throw new ProjectAccessError("NO_SESSION");
  const { project, reason } = await decideAccess(session.userId, slug);
  if (!project) throw new ProjectAccessError(reason ?? "NO_ACCESS");
  return project;
}

/**
 * The active project's id, for raw SQL. `$queryRaw` is the one thing the scoped client cannot
 * reach, so every raw query over a project-owned table adds `"projectId" = ${await activeProjectId()}`.
 */
export async function activeProjectId(): Promise<string> {
  return (await requireActiveProject()).id;
}

/** The projects a user may enter, oldest first — what `/open` chooses between. */
export async function accessibleProjects(userId: string): Promise<ActiveProject[]> {
  const rows = await platformPrisma.projectAccess.findMany({
    where: { userId },
    select: { project: { select: { id: true, slug: true, name: true, createdAt: true } } },
  });
  return rows
    .map((row) => row.project)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map(({ id, slug, name }) => ({ id, slug, name }));
}
