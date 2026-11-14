import "server-only";
import {
  BUSINESS_APP_CONNECT_CLAIM_MS,
  BUSINESS_APP_CONTRACT_VERSION,
  businessAppDefinition,
  decideLaunch,
  installRefusal,
  isBusinessAppKey,
  LAUNCH_REFUSAL_MESSAGES,
  notAvailableError,
  type BusinessAppAdapter,
  type BusinessAppDefinition,
  type BusinessAppKey,
  type BusinessAppStatus,
  type LaunchRefusal,
} from "@support-automation/shared";
import { platformPrisma, prisma } from "@/server/db";
import { requireSession, type Session } from "@/server/auth";
import { hasPermission } from "@/server/permissions";
import { ProjectAccessError, requireActiveProject, type ActiveProject } from "@/server/projectContext";
import { isUniqueViolation } from "@/lib/prismaErrors";

/**
 * Business Apps on the host side (docs/BUSINESS_APP_INTEGRATION_CONTRACT.md). Two halves:
 *   - the Main Admin's: add an app to a project, connect, disable, enable — through `platformPrisma`, which
 *     confines installations to the customer's own projects (TENANT_PARENT "project");
 *   - the workspace's: which apps a person may open, and whether one launch is allowed — through the
 *     project-scoped `prisma`, so another project's installation is simply not found.
 * No external call ever runs inside a transaction, and nothing here marks an installation ACTIVE except a
 * verified answer from an adapter (the database refuses ACTIVE without one too).
 */

export const OPEN_KEY = "business_apps.open" as const;

export interface InstallationView {
  id: string;
  projectId: string;
  appKey: BusinessAppKey;
  status: BusinessAppStatus;
  contractVersion: string;
  externalWorkspaceId: string | null;
  lastConnectedAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  disabledAt: Date | null;
  installedByName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const VIEW_SELECT = {
  id: true,
  projectId: true,
  appKey: true,
  status: true,
  contractVersion: true,
  externalWorkspaceId: true,
  lastConnectedAt: true,
  lastError: true,
  lastErrorAt: true,
  disabledAt: true,
  installedByName: true,
  createdAt: true,
  updatedAt: true,
} as const;

const asView = (row: { appKey: string; status: string } & Omit<InstallationView, "appKey" | "status">): InstallationView => ({
  ...row,
  appKey: row.appKey as BusinessAppKey,
  status: row.status as BusinessAppStatus,
});

// ── Adapters ──────────────────────────────────────────────────────────────────────────────────────
// None is registered: no Business App has published an endpoint yet (WAITING FOR COMMERCE). A real adapter
// is registered here, at startup, once one exists; until then every check answers NOT_AVAILABLE.
const adapters = new Map<BusinessAppKey, BusinessAppAdapter>();

export function registerBusinessAppAdapter(adapter: BusinessAppAdapter | null, key?: BusinessAppKey): void {
  if (adapter) adapters.set(adapter.appKey, adapter);
  else if (key) adapters.delete(key);
}

export function businessAppAdapterFor(key: BusinessAppKey): BusinessAppAdapter | null {
  return adapters.get(key) ?? null;
}

// ── Main Admin: installations ─────────────────────────────────────────────────────────────────────

export async function listProjectInstallations(projectId: string): Promise<InstallationView[]> {
  const rows = await platformPrisma.projectAppInstallation.findMany({ where: { projectId }, select: VIEW_SELECT, orderBy: { createdAt: "asc" } });
  return rows.map(asView);
}

/** Every installation in the customer's own projects, with the project's name — for the portal's overview. */
export async function listCustomerInstallations(): Promise<Array<InstallationView & { projectName: string; projectSlug: string; projectStatus: string }>> {
  const rows = await platformPrisma.projectAppInstallation.findMany({
    select: { ...VIEW_SELECT, project: { select: { name: true, slug: true, status: true } } },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(({ project, ...row }) => ({ ...asView(row), projectName: project.name, projectSlug: project.slug, projectStatus: project.status }));
}

export type InstallResult = { ok: true; installationId: string } | { ok: false; error: string };

/**
 * Add one app to one project, PENDING. The project is looked up through the customer-scoped client, so
 * another customer's project is "no longer exists". A second add of the same app is refused by the unique
 * (project, app) index, not by a read-then-write.
 */
export async function installBusinessApp(projectId: string, appKey: string, actor: Pick<Session, "userId" | "username">): Promise<InstallResult> {
  const refusal = installRefusal(appKey);
  if (refusal) return { ok: false, error: refusal };
  const project = await platformPrisma.project.findUnique({ where: { id: projectId }, select: { id: true, status: true } });
  if (!project) return { ok: false, error: "That project no longer exists." };
  if (project.status === "ARCHIVED") return { ok: false, error: "This project is archived. Restore it before adding a Business App." };
  const app = businessAppDefinition(appKey as BusinessAppKey);
  try {
    const row = await platformPrisma.projectAppInstallation.create({
      data: {
        projectId,
        appKey,
        status: "PENDING",
        contractVersion: BUSINESS_APP_CONTRACT_VERSION,
        installedById: actor.userId,
        installedByName: actor.username,
        updatedById: actor.userId,
      },
      select: { id: true },
    });
    return { ok: true, installationId: row.id };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, error: `${app.name} is already added to this project.` };
    throw err;
  }
}

export type ChangeResult = { ok: true; message: string; status: BusinessAppStatus } | { ok: false; error: string };

async function installationInCustomer(installationId: string) {
  return platformPrisma.projectAppInstallation.findFirst({
    where: { id: installationId },
    select: { ...VIEW_SELECT, project: { select: { status: true, name: true } } },
  });
}

/**
 * Check the connection: claim CONNECTING (a conditional update, so two checks never run at once), ask the
 * app's adapter OUTSIDE any transaction, then record the answer only if the claim is still ours. ACTIVE only
 * on a verified answer; "the app is not available yet" leaves it waiting (PENDING) with the reason; anything
 * else is ERROR with the reason.
 */
export async function connectBusinessApp(installationId: string, actor: Pick<Session, "userId">): Promise<ChangeResult> {
  const row = await installationInCustomer(installationId);
  if (!row) return { ok: false, error: "That installation no longer exists." };
  const app = businessAppDefinition(row.appKey as BusinessAppKey);
  if (row.project.status === "ARCHIVED" || row.project.status === "SUSPENDED") {
    return { ok: false, error: `${row.project.name} is ${row.project.status.toLowerCase()}, so its Business Apps cannot be connected.` };
  }
  if (row.status === "DISABLED") return { ok: false, error: `${app.name} is disabled here. Enable it first.` };

  const claimedAt = new Date();
  const staleBefore = new Date(claimedAt.getTime() - BUSINESS_APP_CONNECT_CLAIM_MS);
  const claim = await platformPrisma.projectAppInstallation.updateMany({
    where: { id: installationId, OR: [{ status: { in: ["PENDING", "ERROR", "ACTIVE"] } }, { status: "CONNECTING", updatedAt: { lt: staleBefore } }] },
    data: { status: "CONNECTING", updatedAt: claimedAt, updatedById: actor.userId },
  });
  if (claim.count === 0) return { ok: false, error: `${app.name} is already being connected. Wait a moment and reload.` };

  const adapter = businessAppAdapterFor(app.key);
  const ref = { projectId: row.projectId, appKey: app.key, externalWorkspaceId: row.externalWorkspaceId, contractVersion: row.contractVersion };
  let result: Awaited<ReturnType<BusinessAppAdapter["verifyConnection"]>>;
  try {
    result = adapter ? await adapter.verifyConnection(ref) : { ok: false, error: notAvailableError(app.name) };
  } catch {
    result = { ok: false, error: { code: "UPSTREAM_ERROR", message: `${app.name} did not answer the connection check.`, retryable: true } };
  }

  const ours = { id: installationId, status: "CONNECTING", updatedAt: claimedAt };
  const now = new Date();
  if (result.ok && result.data.externalWorkspaceId) {
    const done = await platformPrisma.projectAppInstallation.updateMany({
      where: ours,
      data: { status: "ACTIVE", externalWorkspaceId: result.data.externalWorkspaceId, lastConnectedAt: now, lastError: null, lastErrorAt: null, updatedById: actor.userId },
    });
    return done.count ? { ok: true, status: "ACTIVE", message: `${app.name} is connected.` } : { ok: false, error: "The installation changed while it was being connected. Reload and try again." };
  }
  const error = result.ok ? { code: "CONTRACT_MISMATCH" as const, message: `${app.name} answered without a workspace id, so the connection was not accepted.` } : result.error;
  // "Not available yet" is the normal state before an app publishes its endpoint: back to waiting, with why.
  // A previously verified installation that now fails is a problem, not a wait.
  const next: BusinessAppStatus = error.code === "NOT_AVAILABLE" && row.status !== "ACTIVE" ? "PENDING" : "ERROR";
  await platformPrisma.projectAppInstallation.updateMany({
    where: ours,
    data: { status: next, lastError: error.message.slice(0, 500), lastErrorAt: now, updatedById: actor.userId },
  });
  return { ok: false, error: error.message };
}

/** Disable (from any state) or enable (DISABLED → PENDING: the connection is verified again before it is ACTIVE). */
export async function setBusinessAppEnabled(installationId: string, enabled: boolean, actor: Pick<Session, "userId">): Promise<ChangeResult> {
  const row = await installationInCustomer(installationId);
  if (!row) return { ok: false, error: "That installation no longer exists." };
  const app = businessAppDefinition(row.appKey as BusinessAppKey);
  if (!enabled) {
    if (row.status === "DISABLED") return { ok: true, status: "DISABLED", message: `${app.name} is already disabled.` };
    await platformPrisma.projectAppInstallation.updateMany({
      where: { id: installationId, status: { not: "DISABLED" } },
      data: { status: "DISABLED", disabledAt: new Date(), updatedById: actor.userId },
    });
    return { ok: true, status: "DISABLED", message: `${app.name} is disabled. Nothing reaches it from this project; nothing was deleted.` };
  }
  if (row.status !== "DISABLED") return { ok: true, status: row.status as BusinessAppStatus, message: `${app.name} is not disabled.` };
  if (row.project.status === "ARCHIVED") return { ok: false, error: "This project is archived. Restore it first." };
  const done = await platformPrisma.projectAppInstallation.updateMany({
    where: { id: installationId, status: "DISABLED" },
    data: { status: "PENDING", disabledAt: null, updatedById: actor.userId },
  });
  if (!done.count) return { ok: false, error: "The installation changed meanwhile. Reload and try again." };
  return { ok: true, status: "PENDING", message: `${app.name} is enabled. Connect it to check the connection again.` };
}

// ── Workspace: opening an app ─────────────────────────────────────────────────────────────────────

export interface LaunchableApp {
  key: BusinessAppKey;
  name: string;
  icon: BusinessAppDefinition["icon"];
}

/**
 * The apps this person may open in the active project, for the sidebar: ACTIVE installations, in a project
 * that operates, for a role holding `business_apps.open`. Empty — and no query on installations — without
 * the key.
 */
export async function launchableBusinessApps(session: Session, project: ActiveProject): Promise<LaunchableApp[]> {
  if (project.status === "SUSPENDED" || project.status === "ARCHIVED") return [];
  if (!(await hasPermission(session, OPEN_KEY))) return [];
  const rows = await prisma.projectAppInstallation.findMany({ where: { status: "ACTIVE" }, select: { appKey: true }, orderBy: { createdAt: "asc" } });
  return rows.filter((r) => isBusinessAppKey(r.appKey)).map((r) => {
    const app = businessAppDefinition(r.appKey as BusinessAppKey);
    return { key: app.key, name: app.name, icon: app.icon };
  });
}

/** Every installation of the active project, for the workspace's Business Apps page (a person with the key). */
export async function projectInstallationsInWorkspace(): Promise<InstallationView[]> {
  const rows = await prisma.projectAppInstallation.findMany({ select: VIEW_SELECT, orderBy: { createdAt: "asc" } });
  return rows.map(asView);
}

export type LaunchDecision =
  | { ok: true; session: Session; project: ActiveProject; installation: InstallationView; app: BusinessAppDefinition }
  | { ok: false; refusal: LaunchRefusal | "NO_PROJECT_ACCESS"; message: string; installation: InstallationView | null };

/**
 * Whether the signed-in person may open this app in the URL's project, in the order: session → project
 * access (the same step every page takes) → project status → installation (through the project-scoped
 * client: another project's or customer's installation is never found) → the person's permission.
 * The launcher page and the launch action both call this; neither decides on its own.
 */
export async function authorizeBusinessAppLaunch(appKey: string): Promise<LaunchDecision> {
  const session = await requireSession();
  let project: ActiveProject;
  try {
    project = await requireActiveProject();
  } catch (err) {
    if (err instanceof ProjectAccessError) return { ok: false, refusal: "NO_PROJECT_ACCESS", message: "You do not have access to this project.", installation: null };
    throw err;
  }
  if (!isBusinessAppKey(appKey)) return { ok: false, refusal: "UNKNOWN_APP", message: LAUNCH_REFUSAL_MESSAGES.UNKNOWN_APP, installation: null };
  const row = await prisma.projectAppInstallation.findFirst({ where: { appKey }, select: VIEW_SELECT });
  const installation = row ? asView(row) : null;
  const mayOpen = await hasPermission(session, OPEN_KEY);
  const decision = decideLaunch({ appKey, projectStatus: project.status, installation, mayOpen });
  if (!decision.ok) return { ok: false, refusal: decision.refusal, message: LAUNCH_REFUSAL_MESSAGES[decision.refusal], installation: mayOpen ? installation : null };
  return { ok: true, session, project, installation: installation!, app: businessAppDefinition(appKey) };
}
