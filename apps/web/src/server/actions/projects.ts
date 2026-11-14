"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ClientCodeSeriesError, createProjectWithDefaults, customerPlanForNewProject } from "@support-automation/db";
import {
  canTransitionProject,
  CREATABLE_PROJECT_STATUSES,
  isProjectFeatureKey,
  projectFeatureDefinition,
  isProjectStatus,
  removalImpact,
  normalizeProjectName,
  sanitizeRequestedAddOns,
  PROJECT_STATUS_LABELS,
  validateProjectName,
  validateProjectSlug,
} from "@support-automation/shared";
import { globalPrisma, platformPrisma } from "@/server/db";
import { requireSession, verifyPassword, type Session } from "@/server/auth";
import { hasPermission } from "@/server/permissions";
import { forgetProjectAccessDecisions } from "@/server/projectContext";
import { logSystemEvent } from "@/server/logSystemEvent";
import { isUniqueViolation } from "@/lib/prismaErrors";
import { applyProjectModules } from "@/server/actions/projectModules";
import { applyModuleSelection, findModuleTemplate, getProjectModuleState } from "@/server/projectModules";
import { forgetProjectFeatureStates } from "@/server/projectFeatures";
import { currentTenant, customerOfTenant } from "@/server/tenant";
import { recordFailedSecret } from "@/server/loginLockout";
import { deleteProjectData } from "@/server/projectDeletion";
import { installBusinessApp } from "@/server/businessApps";

/**
 * Main Admin Portal actions (MULTI_PROJECT_PLAN.md §7–§8). Every one requires `projects.manage` —
 * checked here, in the action, because a Server Action is a public endpoint whatever page shows
 * its button. They touch only platform rows (Project, ProjectAccess) and, on creation, the new
 * project's own default rows. Nothing here reads or changes any project's operational data, and
 * nothing here changes a user's role: project access is yes/no and nothing more.
 */

export interface ProjectFormState {
  error?: string;
  fieldErrors?: { name?: string; slug?: string; codePrefix?: string; codeWidth?: string; codeStart?: string };
}

const MANAGE_DENIED = "Managing projects needs the “Manage Projects and Project Access” permission.";

async function requireManage(): Promise<{ session: Session } | { denied: string }> {
  const session = await requireSession();
  return (await hasPermission(session, "projects.manage")) ? { session } : { denied: MANAGE_DENIED };
}

export async function createProject(_prev: ProjectFormState, formData: FormData): Promise<ProjectFormState> {
  const access = await requireManage();
  if ("denied" in access) return { error: access.denied };

  const name = normalizeProjectName(String(formData.get("name") ?? ""));
  const slug = String(formData.get("slug") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim().slice(0, 500) || null;
  const statusRaw = String(formData.get("status") ?? "SETUP");
  const status =
    isProjectStatus(statusRaw) && CREATABLE_PROJECT_STATUSES.includes(statusRaw) ? (statusRaw as "SETUP" | "ACTIVE") : null;

  const fieldErrors: ProjectFormState["fieldErrors"] = {};
  const nameError = validateProjectName(name);
  if (nameError) fieldErrors.name = nameError;
  const slugError = validateProjectSlug(slug);
  if (slugError) fieldErrors.slug = slugError;
  if (!status) return { error: "A new project starts as Setting up or Active." };

  if (!fieldErrors.name) {
    // Not a database constraint: two projects called "Bizify" and "bizify" would be told apart by
    // nobody reading the switcher.
    const sameName = await platformPrisma.project.findFirst({ where: { name: { equals: name, mode: "insensitive" } }, select: { id: true } });
    if (sameName) fieldErrors.name = `A project called "${name}" already exists.`;
  }
  if (!fieldErrors.slug) {
    // Only this customer's projects: another customer's address is theirs and says nothing here.
    const sameSlug = await platformPrisma.project.findFirst({ where: { slug }, select: { id: true } });
    if (sameSlug) fieldErrors.slug = `You already have a project at "${slug}". Choose another address.`;
  }
  if (fieldErrors.name || fieldErrors.slug) return { fieldErrors };

  let created: { id: string; slug: string };
  try {
    // The client code series (CLIENT_CODES.md): numbers only for the customer's first project, otherwise the prefix
    // chosen here — checked again inside the creating transaction, under a per-customer lock.
    const width = Number(formData.get("codeWidth") ?? "");
    const clientCode = {
      prefix: String(formData.get("codePrefix") ?? "").trim() || null,
      minWidth: Number.isFinite(width) && width > 0 ? width : null,
      startSerial: String(formData.get("codeStart") ?? "").trim() || null,
    };
    // A customer's new project gets the modules of its plan (every module on All Access, SAAS §12) — in the
    // same transaction that creates it, so a failure can never leave a project on the default modules.
    const plan = await customerPlanForNewProject(globalPrisma, await customerOfTenant(await currentTenant()));
    created = await createProjectWithDefaults({ name, slug, description, status, creatorUserId: access.session.userId, clientCode, plan }, platformPrisma);
  } catch (err) {
    if (err instanceof ClientCodeSeriesError) {
      const key = err.field === "minWidth" ? "codeWidth" : err.field === "nextSerial" ? "codeStart" : "codePrefix";
      return { fieldErrors: { [key]: err.message } };
    }
    // Two people creating the same address in this customer at once.
    if (isUniqueViolation(err)) return { fieldErrors: { slug: `The address "${slug}" is not available. Choose another.` } };
    throw err;
  }

  // Business type / template (PROJECT_MODULES.md §5.1). "PLAN" keeps exactly the behaviour above;
  // "CUSTOM" keeps it too and opens the Module Builder next. A template is applied on top of the plan
  // through the one apply path, fitted to the plan: anything the plan does not include is left out
  // and named in the history, never a reason for creating the project to fail.
  const setup = String(formData.get("moduleSetup") ?? "PLAN");
  let setupNote: string | null = null;
  if (setup !== "PLAN" && setup !== "CUSTOM") {
    const owner = (await platformPrisma.project.findUnique({ where: { id: created.id }, select: { customerId: true } }))?.customerId ?? null;
    const template = await findModuleTemplate(setup, owner);
    if (template) {
      const applied = await applyModuleSelection(platformPrisma, {
        projectId: created.id,
        modules: template.modules,
        declined: template.declined,
        baseType: template.baseType,
        expectedVersion: 0,
        reason: `Created with the "${template.name}" template`,
        actor: access.session.username,
        template: { key: template.key, version: template.version },
        mode: "fitToPlan",
      });
      setupNote = applied.error ? `Template not applied: ${applied.error}` : applied.leftOut?.length ? `Left out (not in the plan): ${applied.leftOut.join(", ")}` : null;
      forgetProjectFeatureStates();
    } else setupNote = "Template not found; the plan's modules were kept.";
  }

  // Business Add-ons (docs/BUSINESS_APP_INTEGRATION_CONTRACT.md), optional and none by default: with none
  // chosen nothing below runs, so creating a project is exactly what it was. Each chosen app is added PENDING
  // after the project exists — no call to any app, inside or outside a transaction — and a failure is noted,
  // never a reason for the project to fail.
  const addOns = sanitizeRequestedAddOns(formData.getAll("businessApps"));
  const addOnNotes: string[] = [];
  for (const appKey of addOns) {
    const installed = await installBusinessApp(created.id, appKey, access.session);
    if (!installed.ok) addOnNotes.push(`${appKey}: ${installed.error}`);
  }

  forgetProjectAccessDecisions();
  await logSystemEvent("INFO", "projects", `Project "${name}" created`, {
    projectId: created.id,
    slug,
    status,
    moduleSetup: setup,
    moduleSetupNote: setupNote,
    createdBy: access.session.username,
    ...(addOns.length ? { businessApps: addOns, businessAppNotes: addOnNotes } : {}),
  });
  revalidatePath("/admin", "layout");
  redirect(setup === "CUSTOM" ? `/admin/projects/${created.id}/modules?created=1` : `/admin/projects/${created.id}?created=1`);
}

export interface ProjectActionResult {
  error?: string;
  success?: string;
}

export interface ProjectDetailsState {
  error?: string;
  fieldErrors?: { name?: string; description?: string };
  savedAt?: number;
}

/**
 * Rename a project and edit its description. The SLUG is deliberately not editable: it is the
 * project's address (/p/<slug>/), and changing it would break every bookmark, every shared link
 * and every browser's remembered last project. A name is only a label — the code never compares a
 * project's name (or slug) to decide anything — so renaming changes what people see and nothing
 * else.
 */
export async function updateProjectDetails(projectId: string, _prev: ProjectDetailsState, formData: FormData): Promise<ProjectDetailsState> {
  const access = await requireManage();
  if ("denied" in access) return { error: access.denied };

  const name = normalizeProjectName(String(formData.get("name") ?? ""));
  const description = String(formData.get("description") ?? "").trim();
  const fieldErrors: NonNullable<ProjectDetailsState["fieldErrors"]> = {};
  const nameError = validateProjectName(name);
  if (nameError) fieldErrors.name = nameError;
  if (description.length > 500) fieldErrors.description = "Keep the description under 500 characters.";

  const project = await platformPrisma.project.findUnique({ where: { id: projectId }, select: { id: true, name: true, description: true } });
  if (!project) return { error: "That project no longer exists." };

  if (!fieldErrors.name) {
    // The same rule as creating one: two projects told apart only by capital letters would be told
    // apart by nobody reading the switcher.
    const sameName = await platformPrisma.project.findFirst({
      where: { name: { equals: name, mode: "insensitive" }, id: { not: projectId } },
      select: { id: true },
    });
    if (sameName) fieldErrors.name = `A project called "${name}" already exists.`;
  }
  if (fieldErrors.name || fieldErrors.description) return { fieldErrors };

  await platformPrisma.project.update({ where: { id: projectId }, data: { name, description: description || null } });

  forgetProjectAccessDecisions();
  if (project.name !== name) {
    await logSystemEvent("INFO", "projects", `Project "${project.name}" renamed to "${name}"`, {
      projectId,
      from: project.name,
      to: name,
      changedBy: access.session.username,
    });
  }
  if ((project.description ?? "") !== description) {
    await logSystemEvent("INFO", "projects", `Project "${name}" description changed`, { projectId, changedBy: access.session.username });
  }
  revalidatePath("/", "layout");
  return { savedAt: Date.now() };
}

export async function setProjectStatus(projectId: string, nextRaw: string): Promise<ProjectActionResult> {
  const access = await requireManage();
  if ("denied" in access) return { error: access.denied };
  if (!isProjectStatus(nextRaw)) return { error: "Unknown project status." };

  const project = await platformPrisma.project.findUnique({ where: { id: projectId }, select: { id: true, name: true, status: true } });
  if (!project) return { error: "That project no longer exists." };
  if (project.status === nextRaw) return { success: `${project.name} is already ${PROJECT_STATUS_LABELS[nextRaw].toLowerCase()}.` };
  if (!canTransitionProject(project.status, nextRaw)) {
    return {
      error: `A project cannot go from ${PROJECT_STATUS_LABELS[project.status]} to ${PROJECT_STATUS_LABELS[nextRaw]}.`,
    };
  }

  // Compare-and-set on the status read above, so two admins pressing different buttons at once
  // cannot interleave into a transition neither of them chose.
  const updated = await platformPrisma.project.updateMany({ where: { id: projectId, status: project.status }, data: { status: nextRaw } });
  if (updated.count === 0) return { error: "The project's status changed while you were looking. Reload and try again." };

  forgetProjectAccessDecisions();
  await logSystemEvent("WARN", "projects", `Project "${project.name}" status ${project.status} → ${nextRaw}`, {
    projectId,
    from: project.status,
    to: nextRaw,
    changedBy: access.session.username,
  });
  revalidatePath("/admin", "layout");
  return { success: `${project.name} is now ${PROJECT_STATUS_LABELS[nextRaw].toLowerCase()}.` };
}

export interface ProjectDeletionState {
  error?: string;
  fieldErrors?: { confirmName?: string; password?: string };
  done?: string;
}

/**
 * Delete an ARCHIVED project permanently, with all of its data (PROJECT_DELETION.md). Needs the project's
 * exact name typed and the person's own password (a wrong one counts toward the login lockout). Refused for a
 * support session: erasing a customer's workspace is the customer's own decision. The project is looked up
 * through the customer-scoped client, so another customer's project is "no longer exists".
 */
export async function deleteProject(projectId: string, _prev: ProjectDeletionState, formData: FormData): Promise<ProjectDeletionState> {
  const access = await requireManage();
  if ("denied" in access) return { error: access.denied };
  if (access.session.support) return { error: "A support session cannot delete a project." };

  const project = await platformPrisma.project.findUnique({ where: { id: projectId }, select: { id: true, name: true, status: true } });
  if (!project) return { error: "That project no longer exists." };
  if (project.status !== "ARCHIVED") return { error: "Archive the project first. Only an archived project can be deleted." };

  const fieldErrors: NonNullable<ProjectDeletionState["fieldErrors"]> = {};
  if (String(formData.get("confirmName") ?? "").trim() !== project.name.trim()) fieldErrors.confirmName = `Type the project's name exactly: ${project.name}`;
  const password = String(formData.get("password") ?? "");
  if (!password) fieldErrors.password = "Enter your password.";
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };

  const user = await globalPrisma.user.findUnique({
    where: { id: access.session.userId },
    select: { id: true, username: true, passwordHash: true, customerId: true, supportOperatorId: true, failedLoginAttempts: true, lastFailedLoginAt: true, lockedUntil: true },
  });
  if (!user || user.supportOperatorId) return { error: "A support session cannot delete a project." };
  if (user.lockedUntil && user.lockedUntil > new Date()) return { fieldErrors: { password: "Too many wrong attempts. Wait a few minutes and try again." } };
  if (!verifyPassword(password, user.passwordHash)) {
    await recordFailedSecret(user, user.customerId, "ACCOUNT_PASSWORD_CHECK_FAILED");
    return { fieldErrors: { password: "Your password is not right." } };
  }

  const deleted = await deleteProjectData(project.id);
  if ("error" in deleted) return { error: deleted.error };

  forgetProjectAccessDecisions();
  forgetProjectFeatureStates();
  await logSystemEvent(
    "WARN",
    "projects",
    `Project "${deleted.name}" deleted permanently`,
    { projectId, slug: deleted.slug, deletedBy: access.session.username, rows: deleted.deleted, mediaRemoved: deleted.mediaRemoved },
    { actorUserId: access.session.userId, targetType: "Project", targetId: projectId },
  );
  revalidatePath("/admin", "layout");
  return {
    done: deleted.mediaRemoved
      ? `${deleted.name} was deleted permanently.`
      : `${deleted.name} was deleted permanently. Some files could not be removed from storage; they are no longer linked to anything.`,
  };
}

/**
 * Grant or revoke ONE user's access to ONE project. Yes/no only: the user's role — what they may do
 * inside any project — is never touched here. Revoking takes effect on this server at once; another
 * server process may honour its cached decision for up to five seconds.
 */
export async function setProjectAccess(projectId: string, userId: string, granted: boolean): Promise<ProjectActionResult> {
  const access = await requireManage();
  if ("denied" in access) return { error: access.denied };

  const [project, user] = await Promise.all([
    platformPrisma.project.findUnique({ where: { id: projectId }, select: { id: true, name: true, status: true } }),
    platformPrisma.user.findUnique({ where: { id: userId }, select: { id: true, username: true } }),
  ]);
  if (!project) return { error: "That project no longer exists." };
  if (!user) return { error: "That user no longer exists." };

  if (granted) {
    if (project.status === "ARCHIVED") return { error: `${project.name} is archived; nobody new can be given access. Restore it first.` };
    // Access to another of the customer's workspaces adds no user, so no plan limit applies here.
    await platformPrisma.projectAccess.upsert({
      where: { projectId_userId: { projectId, userId } },
      update: {},
      create: { projectId, userId },
    });
  } else {
    // Their project-level role (PROJECT_ROLES.md) goes with the access, so a later re-grant starts
    // from the global role and never silently revives an old Lead flag.
    await platformPrisma.$transaction([
      platformPrisma.projectMemberRole.deleteMany({ where: { projectId, userId } }),
      platformPrisma.projectAccess.deleteMany({ where: { projectId, userId } }),
    ]);
  }

  forgetProjectAccessDecisions();
  await logSystemEvent("WARN", "projects", `${granted ? "Granted" : "Revoked"} ${user.username}'s access to "${project.name}"`, {
    projectId,
    userId,
    granted,
    changedBy: access.session.username,
  });
  revalidatePath(`/admin/projects/${projectId}`);
  revalidatePath(`/admin/users/${userId}`);
  revalidatePath("/admin/users");
  return { success: granted ? `${user.username} can now enter ${project.name}.` : `${user.username} can no longer enter ${project.name}.` };
}

/**
 * Switch one feature on or off for one project — kept for compatibility, and routed through the Module
 * Builder's own validation (PROJECT_MODULES.md) so this endpoint cannot store what the builder would
 * refuse: a hard dependency removed under a module that needs it, or a module the plan does not include.
 * Removing a module that others need is refused here, naming them; the builder offers to switch them
 * off together.
 */
export async function setProjectFeature(projectId: string, keyRaw: string, enabled: boolean): Promise<ProjectActionResult> {
  const access = await requireManage();
  if ("denied" in access) return { error: access.denied };
  if (!isProjectFeatureKey(keyRaw)) return { error: "Unknown feature." };
  const state = await getProjectModuleState(projectId);
  if (!state) return { error: "That project no longer exists." };
  if (!enabled) {
    const dependents = removalImpact(state.enabled, keyRaw);
    if (dependents.length > 0) {
      return { error: `${projectFeatureDefinition(keyRaw).label} is needed by ${dependents.map((k) => projectFeatureDefinition(k as typeof keyRaw)?.label ?? k).join(", ")}. Switch them off in the Module Builder.` };
    }
  }
  const modules = enabled ? [...new Set([...state.enabled, keyRaw])] : state.enabled.filter((k) => k !== keyRaw);
  const result = await applyProjectModules(projectId, { modules, declined: [], baseType: state.projectBaseType, expectedVersion: state.version, reason: "Single feature switch" });
  if (result.error) return { error: [result.error, ...(result.issues ?? []).map((i) => i.message)].join(" ") };
  return { success: result.success };
}
