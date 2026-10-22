import { AsyncLocalStorage } from "node:async_hooks";
import { headers } from "next/headers";
import { prisma as platformPrisma, ProjectScopeError } from "@support-automation/db";
import { PROJECT_HEADER } from "@/lib/projectPaths";
import { getSession } from "@/server/auth";
import { hostAllowsProject, isReadOnlyProjectStatus, type HostScope, type ProjectAccessLevelValue, type ProjectStatusValue } from "@support-automation/shared";
import { currentHostScope, hostScopeKey } from "@/server/hostScope";
import { foundingCustomerId, registerExplicitProject, tenantOfCustomer } from "@/server/tenant";

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
 *
 * SaaS (SAAS_PLATFORM_PLAN.md §3.3): the hostname narrows it further. On a customer's address only
 * that customer's project opens, for everybody; on an unknown address nothing does. With hostname
 * routing off (the default) the hostname changes nothing (`hostAllowsProject` → true).
 */

export interface ActiveProject {
  id: string;
  slug: string;
  name: string;
  /**
   * SUSPENDED and ARCHIVED projects are read-only (server/db.ts refuses their writes). A project held
   * by its SaaS subscription (Project.billingHoldAt) reads as SUSPENDED here, so every existing
   * read-only rule applies to it unchanged (SAAS_PLATFORM_PLAN.md section 10).
   */
  status: ProjectStatusValue;
  /** True when the read-only status comes from the customer's subscription, not from an admin. */
  billingHold?: boolean;
  /**
   * How much of their role this user may use here (ProjectAccess.level; MAIN_ADMIN_WORKSPACE.md §4).
   * Absent means FULL — a Main Admin with no access row, and every row written before levels existed.
   */
  accessLevel?: ProjectAccessLevelValue;
  /** The customer whose software this project is part of; null = the original installation (§12). Absent = look it up. */
  tenant?: string | null;
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
registerExplicitProject(() => explicitProject.getStore());
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
const PROJECT_WITH_CUSTOMER = { ...PROJECT_SELECT, customerId: true, billingHoldAt: true } as const;

/** The status the app enforces: the project's own, or SUSPENDED while its subscription holds it. */
function effectiveProject(row: { id: string; slug: string; name: string; status: string; billingHoldAt: Date | null }, tenant: string | null): ActiveProject {
  const held = row.billingHoldAt !== null && (row.status === "SETUP" || row.status === "ACTIVE");
  return { id: row.id, slug: row.slug, name: row.name, status: (held ? "SUSPENDED" : row.status) as ProjectStatusValue, ...(held ? { billingHold: true } : {}), tenant };
}

/** The person's customer (null = the original installation). */
async function tenantOfUser(userId: string): Promise<string | null> {
  const user = await platformPrisma.user.findUnique({ where: { id: userId }, select: { customerId: true } });
  return tenantOfCustomer(user?.customerId ?? null);
}

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

async function decideAccess(userId: string, slug: string, scope: HostScope): Promise<{ project: ActiveProject | null; reason?: ProjectAccessFailure }> {
  const key = `${userId} ${slug} ${hostScopeKey(scope)}`;
  const cached = accessCache.get(key);
  if (cached && Date.now() - cached.at < ACCESS_TTL_MS) return cached;

  const row = await platformPrisma.project.findUnique({ where: { slug }, select: PROJECT_WITH_CUSTOMER });
  const projectTenant = row ? await tenantOfCustomer(row.customerId) : null;
  const project = row ? effectiveProject(row, projectTenant) : null;
  let decision: { project: ActiveProject | null; reason?: ProjectAccessFailure };
  // Another customer's project is "unknown", not "forbidden": its existence is not something this
  // person or this address should confirm (SAAS_PLATFORM_PLAN.md §12). A project belongs to one
  // customer's software; it opens only for that customer's people, on that customer's address or an
  // open one, and never on the platform address.
  const sameCustomer = row ? projectTenant === (await tenantOfUser(userId)) : false;
  const projectCustomer = row ? row.customerId ?? (await foundingCustomerId()) : null;
  if (row && (!sameCustomer || (scope.kind !== "OPEN" && !hostAllowsProject(scope, projectCustomer)))) {
    decision = { project: null, reason: "UNKNOWN_PROJECT" };
  } else if (!project) {
    decision = { project: null, reason: "UNKNOWN_PROJECT" };
  } else {
    const access = await platformPrisma.projectAccess.findUnique({
      where: { projectId_userId: { projectId: project.id, userId } },
      select: { id: true, level: true },
    });
    // A customer's Main Admin may enter any of THEIR customer's projects (§7, §12). Inside it they are
    // governed by their existing permissions exactly like anyone else — this only answers "may they
    // come in". A level on their own access row still applies to them: FULL is never a bypass.
    const allowed = Boolean(access) || (await isMainAdmin(userId));
    decision = allowed
      ? { project: { ...project, accessLevel: access?.level ?? "FULL" } }
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
  const { project, reason } = await decideAccess(session.userId, slug, await currentHostScope());
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
  const [mainAdmin, tenant, scope, founding] = await Promise.all([isMainAdmin(userId), tenantOfUser(userId), currentHostScope(), foundingCustomerId()]);
  // Only the person's own customer's projects (§12): for the original installation, the projects with
  // no customer (and any filed under the founding customer).
  const ownCustomer = tenant === null ? { OR: [{ customerId: null }, ...(founding ? [{ customerId: founding }] : [])] } : { customerId: tenant };
  const rows = await platformPrisma.project.findMany({
    where: { AND: [ownCustomer, { status: { not: "ARCHIVED" } }, mainAdmin ? {} : { access: { some: { userId } } }] },
    select: { ...PROJECT_WITH_CUSTOMER, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  return rows
    .filter((row) => scope.kind === "OPEN" || hostAllowsProject(scope, row.customerId ?? founding))
    .map((row) => effectiveProject(row, tenant));
}

/** Whether the active project refuses writes (SUSPENDED / ARCHIVED). */
export async function activeProjectIsReadOnly(): Promise<boolean> {
  return isReadOnlyProjectStatus((await requireActiveProject()).status);
}
