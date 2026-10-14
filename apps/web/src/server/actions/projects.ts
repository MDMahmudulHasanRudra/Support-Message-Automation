"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createProjectWithDefaults } from "@support-automation/db";
import {
  canTransitionProject,
  CREATABLE_PROJECT_STATUSES,
  isProjectFeatureKey,
  projectFeatureDefinition,
  isProjectStatus,
  normalizeProjectName,
  PROJECT_STATUS_LABELS,
  validateProjectName,
  validateProjectSlug,
} from "@support-automation/shared";
import { platformPrisma } from "@/server/db";
import { requireSession, type Session } from "@/server/auth";
import { hasPermission } from "@/server/permissions";
import { forgetProjectAccessDecisions } from "@/server/projectContext";
import { forgetProjectFeatureStates } from "@/server/projectFeatures";
import { logSystemEvent } from "@/server/logSystemEvent";
import { isUniqueViolation } from "@/lib/prismaErrors";

/**
 * Main Admin Portal actions (MULTI_PROJECT_PLAN.md §7–§8). Every one requires `projects.manage` —
 * checked here, in the action, because a Server Action is a public endpoint whatever page shows
 * its button. They touch only platform rows (Project, ProjectAccess) and, on creation, the new
 * project's own default rows. Nothing here reads or changes any project's operational data, and
 * nothing here changes a user's role: project access is yes/no and nothing more.
 */

export interface ProjectFormState {
  error?: string;
  fieldErrors?: { name?: string; slug?: string };
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
    const sameSlug = await platformPrisma.project.findUnique({ where: { slug }, select: { id: true } });
    if (sameSlug) fieldErrors.slug = `The slug "${slug}" is already used by another project.`;
  }
  if (fieldErrors.name || fieldErrors.slug) return { fieldErrors };

  let created: { id: string; slug: string };
  try {
    created = await createProjectWithDefaults({ name, slug, description, status, creatorUserId: access.session.userId }, platformPrisma);
  } catch (err) {
    if (isUniqueViolation(err)) return { fieldErrors: { slug: `The slug "${slug}" is already used by another project.` } };
    throw err;
  }

  forgetProjectAccessDecisions();
  await logSystemEvent("INFO", "projects", `Project "${name}" created`, {
    projectId: created.id,
    slug,
    status,
    createdBy: access.session.username,
  });
  revalidatePath("/admin", "layout");
  redirect(`/admin/projects/${created.id}?created=1`);
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

/**
 * Grant or revoke ONE user's access to ONE project. Yes/no only: the user's role — what they may do
 * inside any project — is never touched here. Revoking takes effect on this server at once; another
 * server process may honour its cached decision for up to five seconds.
 */
export async function setProjectAccess(projectId: string, userId: string, granted: boolean): Promise<ProjectActionResult> {
  const access = await requireManage();
  if ("denied" in access) return { error: access.denied };

  const [project, user] = await Promise.all([
    platformPrisma.project.findUnique({ where: { id: projectId }, select: { id: true, name: true } }),
    platformPrisma.user.findUnique({ where: { id: userId }, select: { id: true, username: true } }),
  ]);
  if (!project) return { error: "That project no longer exists." };
  if (!user) return { error: "That user no longer exists." };

  if (granted) {
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
  return { success: granted ? `${user.username} can now enter ${project.name}.` : `${user.username} can no longer enter ${project.name}.` };
}

/**
 * Switch one feature on or off for one project (MULTI_PROJECT_PLAN.md §9). An entitlement, not a
 * setting: off means the project cannot use the module at all — its pages and actions refuse and the
 * worker skips its background work. The project's own settings for the module are left exactly as
 * they are, so switching it back on resumes where it stopped. Nothing is deleted.
 */
export async function setProjectFeature(projectId: string, keyRaw: string, enabled: boolean): Promise<ProjectActionResult> {
  const access = await requireManage();
  if ("denied" in access) return { error: access.denied };
  if (!isProjectFeatureKey(keyRaw)) return { error: "Unknown feature." };
  const project = await platformPrisma.project.findUnique({ where: { id: projectId }, select: { id: true, name: true } });
  if (!project) return { error: "That project no longer exists." };

  await platformPrisma.projectFeature.upsert({
    where: { projectId_key: { projectId, key: keyRaw } },
    update: { enabled },
    create: { projectId, key: keyRaw, enabled },
  });

  forgetProjectFeatureStates();
  const label = projectFeatureDefinition(keyRaw).label;
  await logSystemEvent("WARN", "projects", `${label} ${enabled ? "enabled" : "disabled"} for "${project.name}"`, {
    projectId,
    feature: keyRaw,
    enabled,
    changedBy: access.session.username,
  });
  revalidatePath(`/admin/projects/${projectId}`);
  return { success: `${label} is now ${enabled ? "on" : "off"} for ${project.name}.` };
}
