import { AsyncLocalStorage } from "node:async_hooks";
import { headers } from "next/headers";
import { prisma as platformPrisma, ProjectScopeError } from "@support-automation/db";
import { PROJECT_HEADER } from "@/lib/projectPaths";
import { getSession } from "@/server/auth";
import { isReadOnlyProjectStatus, type ProjectAccessLevelValue, type ProjectStatusValue } from "@support-automation/shared";

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
  /** SUSPENDED and ARCHIVED projects are read-only (server/db.ts refuses their writes). */
  status: ProjectStatusValue;
  /**
   * How much of their role this user may use here (ProjectAccess.level; MAIN_ADMIN_WORKSPACE.md §4).
   * Absent means FULL — a Main Admin with no access row, and every row written before levels existed.
   */
  accessLevel?: ProjectAccessLevelValue;
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
 * cost two extra lookups. The cost is that a change made in ANOTHER process takes up to this long
 * to bite; a change made through the Main Admin Portal clears the cache of the process that made it
 * at once (`forgetProjectAccessDecisions`).
 */
const ACCESS_TTL_MS = 5_000;
const accessCache = new Map<string, { at: number; project: ActiveProject | null; reason?: ProjectAccessFailure }>();

/** Called after any change to project access, a project's status or a user's role. */
export function forgetProjectAccessDecisions(): void {
  accessCache.clear();
}

const PROJECT_SELECT = { id: true, slug: true, name: true, status: true } as const;

/**
 * Whether this user is a Main Admin: their EXISTING role holds `projects.manage` (§7). Read from the
 * same role → permission rows as every other permission check; nothing about the user is stored on
 * a project. Inactive users are never Main Admins.
 */
export async function isMainAdmin(userId: string): Promise<boolean> {
  const user = await platformPrisma.user.findUnique({
    where: { id: userId },
    select: {
      isActive: true,
      permissionModule: { select: { permissions: { where: { permission: { key: "projects.manage" } }, select: { permissionId: true } } } },
    },
  });
  return Boolean(user?.isActive && user.permissionModule && user.permissionModule.permissions.length > 0);
}

async function decideAccess(userId: string, slug: string): Promise<{ project: ActiveProject | null; reason?: ProjectAccessFailure }> {
  const key = `${userId} ${slug}`;
  const cached = accessCache.get(key);
  if (cached && Date.now() - cached.at < ACCESS_TTL_MS) return cached;

  const project = await platformPrisma.project.findUnique({ where: { slug }, select: PROJECT_SELECT });
  let decision: { project: ActiveProject | null; reason?: ProjectAccessFailure };
  if (!project) {
    decision = { project: null, reason: "UNKNOWN_PROJECT" };
  } else {
    const access = await platformPrisma.projectAccess.findUnique({
      where: { projectId_userId: { projectId: project.id, userId } },
      select: { id: true, level: true },
    });
    // A Main Admin may enter any project (§7). Inside it they are governed by their existing
    // permissions exactly like anyone else — this only answers "may they come in". A level on their
    // own access row still applies to them: FULL is never a bypass, and the narrower rule wins.
    const allowed = Boolean(access) || (await isMainAdmin(userId));
    decision = allowed
      ? { project: { ...project, status: project.status as ProjectStatusValue, accessLevel: access?.level ?? "FULL" } }
      : { project: null, reason: "NO_ACCESS" };
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

/**
 * The projects a user may enter, oldest first: the ones they have been given access to, plus every
 * project for a Main Admin. What `/open` chooses between and what the project switcher lists — never
 * a project merely because it exists. Archived projects are left out (§8: hidden from the switcher);
 * they remain reachable from the Main Admin Portal.
 */
export async function accessibleProjects(userId: string): Promise<ActiveProject[]> {
  const mainAdmin = await isMainAdmin(userId);
  const rows = await platformPrisma.project.findMany({
    where: { status: { not: "ARCHIVED" }, ...(mainAdmin ? {} : { access: { some: { userId } } }) },
    select: { ...PROJECT_SELECT, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(({ id, slug, name, status }) => ({ id, slug, name, status }));
}

/** Whether the active project refuses writes (SUSPENDED / ARCHIVED). */
export async function activeProjectIsReadOnly(): Promise<boolean> {
  return isReadOnlyProjectStatus((await requireActiveProject()).status);
}
