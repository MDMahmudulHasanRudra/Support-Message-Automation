import { AsyncLocalStorage } from "node:async_hooks";
import { prisma as platformPrisma, ProjectScopeError } from "@support-automation/db";

/**
 * The project a piece of worker work belongs to (MULTI_PROJECT_PLAN.md §4.2, Phase 3).
 *
 * The worker takes a project from exactly one place: the WhatsApp account (or, for a queue row, the
 * row the web app stamped, re-checked against the account where one is involved). Never from a
 * message body, a payload field or a default. Everything that runs inside `withProject` reads and
 * writes that project only — the scoped client in ../db.ts enforces it — and nothing may switch to
 * another project from inside one: a nested `withProject` for a different project throws.
 */

const store = new AsyncLocalStorage<{ projectId: string }>();

/** The current project, or a ProjectScopeError — never a guess. */
export function currentProjectId(): string {
  const context = store.getStore();
  if (!context) throw new ProjectScopeError("Worker code touched project data outside a project context; refused.");
  return context.projectId;
}

/** The current project, or null — for code that must behave differently at platform level. */
export function maybeCurrentProjectId(): string | null {
  return store.getStore()?.projectId ?? null;
}

const PROJECT_CACHE_TTL_MS = 60_000;
const knownProjects = new Map<string, { at: number; exists: boolean }>();

async function projectExists(projectId: string): Promise<boolean> {
  const cached = knownProjects.get(projectId);
  if (cached && Date.now() - cached.at < PROJECT_CACHE_TTL_MS) return cached.exists;
  const exists = (await platformPrisma.project.count({ where: { id: projectId } })) > 0;
  knownProjects.set(projectId, { at: Date.now(), exists });
  return exists;
}

/**
 * Runs `fn` as project `projectId`. Refuses an empty or unknown project, and refuses to switch
 * project from inside another one (re-entering the SAME project is fine).
 */
export async function withProject<T>(projectId: string | null | undefined, fn: () => Promise<T>): Promise<T> {
  if (!projectId) throw new ProjectScopeError("No project given for worker work; refused.");
  const current = store.getStore();
  if (current) {
    if (current.projectId !== projectId) {
      throw new ProjectScopeError(`Refused to switch from project ${current.projectId} to ${projectId} inside worker work.`);
    }
    return await fn();
  }
  if (!(await projectExists(projectId))) throw new ProjectScopeError(`Unknown project ${projectId}; refused.`);
  // Awaited INSIDE the context, and that is load-bearing: a Prisma query is a lazy thenable that
  // only runs when awaited, so `withProject(id, () => prisma.x.update(...))` returning the bare
  // promise would run the query after `run()` had already exited — outside any project.
  return store.run({ projectId }, async () => await fn());
}

/**
 * Which project owns a WhatsApp account — the authoritative link. Cached: an account never moves
 * between projects (the column is set when the account is created in a project). An unknown
 * account is a ProjectScopeError, never a default.
 */
const accountProjects = new Map<string, { at: number; projectId: string }>();
export async function projectIdForAccount(accountId: string): Promise<string> {
  const cached = accountProjects.get(accountId);
  if (cached && Date.now() - cached.at < PROJECT_CACHE_TTL_MS) return cached.projectId;
  const account = await platformPrisma.whatsAppAccount.findUnique({ where: { id: accountId }, select: { projectId: true } });
  if (!account) throw new ProjectScopeError(`WhatsApp account ${accountId} does not exist; its work is refused.`);
  accountProjects.set(accountId, { at: Date.now(), projectId: account.projectId });
  return account.projectId;
}

/** Runs `fn` as the project that owns `accountId`. */
export async function withAccountProject<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  return withProject(await projectIdForAccount(accountId), fn);
}

/**
 * The statuses in which the worker does outward or background work for a project (§8): a SUSPENDED
 * project stops sending and its scanners stop; an ARCHIVED one also has its accounts disconnected.
 * Incoming messages are stored in every status — collection is a push, and anything missed is gone.
 */
export const OPERATING_PROJECT_STATUSES = ["SETUP", "ACTIVE"] as const;

/**
 * The projects background work runs for: every SETUP or ACTIVE one, oldest first. Cached briefly
 * because the 2-second queue loops ask on every tick; a project created, suspended or reactivated
 * in the dashboard is picked up within PROJECT_LIST_TTL_MS.
 */
const PROJECT_LIST_TTL_MS = 30_000;
let projectList: { at: number; ids: string[] } | null = null;
export async function activeProjectIds(): Promise<string[]> {
  if (projectList && Date.now() - projectList.at < PROJECT_LIST_TTL_MS) return projectList.ids;
  const projects = await platformPrisma.project.findMany({
    where: { status: { in: [...OPERATING_PROJECT_STATUSES] } },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  projectList = { at: Date.now(), ids: projects.map((p) => p.id) };
  return projectList.ids;
}

/**
 * Runs `fn` once per project, each inside its own context, one after another — for the loops that
 * used to read the whole database (queues, learning, knowledge, Forge). Each project's settings,
 * kill switch and data are therefore read separately, exactly as a single-project install read
 * its own. A project whose run throws is logged and the next one still runs: one project's
 * failure must not starve the others. Suspended and archived projects are skipped.
 */
export async function forEachProject(label: string, fn: (projectId: string) => Promise<unknown>): Promise<void> {
  for (const id of await activeProjectIds()) {
    try {
      await withProject(id, () => fn(id));
    } catch (err) {
      console.error(`[${label}] project ${id} failed; continuing with the next project`, err);
    }
  }
}

/**
 * Whether the worker should act for this project right now — send, automate, scan. Cached like the
 * project list, so a suspension takes effect within PROJECT_LIST_TTL_MS; an unknown project is not
 * operating.
 */
const operatingCache = new Map<string, { at: number; operating: boolean }>();
export async function projectIsOperating(projectId: string): Promise<boolean> {
  const cached = operatingCache.get(projectId);
  if (cached && Date.now() - cached.at < PROJECT_LIST_TTL_MS) return cached.operating;
  const project = await platformPrisma.project.findUnique({ where: { id: projectId }, select: { status: true } });
  const operating = Boolean(project && (OPERATING_PROJECT_STATUSES as readonly string[]).includes(project.status));
  operatingCache.set(projectId, { at: Date.now(), operating });
  return operating;
}

/** Test seam: forget cached project/account lookups (fixtures create and delete projects). */
export function resetProjectCachesForTests(): void {
  knownProjects.clear();
  accountProjects.clear();
  operatingCache.clear();
  projectList = null;
}

/**
 * Whether `accountId` belongs to the project of the work in progress. False — never a throw — for
 * an account in another project or one that no longer exists, so a sender can refuse cleanly.
 */
export async function accountInCurrentProject(accountId: string): Promise<boolean> {
  try {
    return (await projectIdForAccount(accountId)) === currentProjectId();
  } catch (err) {
    if (err instanceof ProjectScopeError && maybeCurrentProjectId()) return false;
    throw err;
  }
}
