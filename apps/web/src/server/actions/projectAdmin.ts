"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { checkPermission } from "@/server/authorize";
import { hashPassword } from "@/server/auth";
import { platformPrisma, prisma } from "@/server/db";
import { createUserWithAccess } from "@/server/adminUsers";
import { forgetProjectAccessDecisions, requireActiveProject } from "@/server/projectContext";
import { memberFacts } from "@/server/projectAdmin";
import { projectPath } from "@/server/projectPaths";
import { logSystemEvent } from "@/server/logSystemEvent";
import { isUniqueViolation } from "@/lib/prismaErrors";
import { MIN_PASSWORD_LENGTH } from "@/lib/userRules";
import { keysForSectionAccess, sanitizeSectionAccess } from "@/app/p/[project]/(dashboard)/projectSections";

/**
 * Project administration (PROJECT_ROLES.md): a project's Lead — or a Main Admin — runs ONE project's
 * members and project roles. Every action is a public endpoint, so each one checks for itself:
 *
 *   members   `project_members.manage` in the project in the URL (a Lead holds it there, and only there)
 *   roles     `project_roles.manage`, likewise
 *
 * `checkPermission` also applies the access level, the project's status (a suspended project is
 * read-only) and refuses a project the user may not enter. Who may be changed is
 * `projectMemberActions` (packages/shared), the same rule the page uses to show its buttons.
 * Nothing here can grant a platform key: project roles are filtered to `isProjectAssignableKey`
 * (and a database CHECK refuses the dangerous ones), and the Lead flag is only the Main Admin's.
 */

export interface ProjectAdminState {
  error?: string;
  success?: string;
}

async function membersAdmin() {
  const granted = await checkPermission("project_members.manage");
  if ("denied" in granted) return { denied: granted.denied };
  return { session: granted.session, project: await requireActiveProject() };
}

async function rolesAdmin() {
  const granted = await checkPermission("project_roles.manage");
  if ("denied" in granted) return { denied: granted.denied };
  return { session: granted.session, project: await requireActiveProject() };
}

const NOT_ALLOWED = "You cannot change this member here. A Main Admin can, from the Main Admin Portal.";

async function refreshMembers() {
  revalidatePath(await projectPath("/project-members"));
}

/** A new login that belongs to this project: no global role, access to this project, the chosen project role. */
export async function createProjectMember(_prev: ProjectAdminState, form: FormData): Promise<ProjectAdminState> {
  const admin = await membersAdmin();
  if ("denied" in admin) return { error: admin.denied };
  const projectRoleId = String(form.get("projectRoleId") ?? "").trim();
  if (!projectRoleId) return { error: "Choose the member's project role. Create one under Project Roles first if there is none." };
  // The scoped client only finds a role of the project in the URL.
  const role = await prisma.projectRole.findFirst({ where: { id: projectRoleId }, select: { id: true, name: true } });
  if (!role) return { error: "That project role no longer exists in this project." };

  const result = await createUserWithAccess(platformPrisma, {
    username: form.get("username"),
    name: form.get("name"),
    email: form.get("email"),
    password: form.get("password"),
    confirmPassword: form.get("confirmPassword"),
    permissionModuleId: null,
    employee: null,
    access: [{ projectId: admin.project.id, level: "FULL", projectRoleId: role.id }],
  });
  if (!result.ok) return { error: result.error };

  forgetProjectAccessDecisions();
  await logSystemEvent("INFO", "users", "PROJECT_MEMBER_CREATED", {
    actorId: admin.session.userId,
    targetUserId: result.userId,
    projectRole: role.name,
  });
  await refreshMembers();
  redirect(await projectPath("/project-members?created=1"));
}

/** The member's project role here. Leaving it empty is only possible for someone who has a global role to fall back on. */
export async function setMemberProjectRole(userId: string, projectRoleIdRaw: string): Promise<ProjectAdminState> {
  const admin = await membersAdmin();
  if ("denied" in admin) return { error: admin.denied };
  const facts = await memberFacts(admin.project.id, userId, admin.session.userId);
  if (!facts) return { error: "That person is not a member of this project." };
  if (!facts.can.changeRole) return { error: NOT_ALLOWED };

  const projectRoleId = projectRoleIdRaw || null;
  let roleName: string | null = null;
  if (projectRoleId) {
    const role = await prisma.projectRole.findFirst({ where: { id: projectRoleId }, select: { name: true } });
    if (!role) return { error: "That project role no longer exists in this project." };
    roleName = role.name;
  } else if (facts.user.permissionModuleId === null) {
    return { error: "This member has no global role, so without a project role they could do nothing here. Choose a role, or remove them." };
  }
  if ((facts.memberRole?.projectRoleId ?? null) === projectRoleId) return { success: "No change." };

  if (projectRoleId === null && !facts.memberRole?.isLead) {
    await platformPrisma.projectMemberRole.deleteMany({ where: { projectId: admin.project.id, userId } });
  } else {
    await platformPrisma.projectMemberRole.upsert({
      where: { projectId_userId: { projectId: admin.project.id, userId } },
      update: { projectRoleId },
      create: { projectId: admin.project.id, userId, projectRoleId },
    });
  }
  await logSystemEvent("WARN", "users", "PROJECT_MEMBER_ROLE_CHANGED", { actorId: admin.session.userId, targetUserId: userId, projectRole: roleName });
  await refreshMembers();
  return { success: roleName ? `Project role set to ${roleName}.` : "Now uses their global role in this project." };
}

/** Takes away this project only: the login, and any other project, are untouched. */
export async function removeProjectMember(userId: string): Promise<ProjectAdminState> {
  const admin = await membersAdmin();
  if ("denied" in admin) return { error: admin.denied };
  const facts = await memberFacts(admin.project.id, userId, admin.session.userId);
  if (!facts) return { error: "That person is not a member of this project." };
  if (!facts.can.remove) return { error: NOT_ALLOWED };
  await platformPrisma.$transaction([
    platformPrisma.projectMemberRole.deleteMany({ where: { projectId: admin.project.id, userId } }),
    platformPrisma.projectAccess.deleteMany({ where: { projectId: admin.project.id, userId } }),
  ]);
  forgetProjectAccessDecisions();
  await logSystemEvent("WARN", "users", "PROJECT_MEMBER_REMOVED", { actorId: admin.session.userId, targetUserId: userId });
  await refreshMembers();
  return { success: `${facts.user.username} can no longer enter this project.` };
}

/** Only for a login that exists for this project alone (or by a Main Admin). Signs them out everywhere. */
export async function resetProjectMemberPassword(userId: string, newPassword: string): Promise<ProjectAdminState> {
  const admin = await membersAdmin();
  if ("denied" in admin) return { error: admin.denied };
  const facts = await memberFacts(admin.project.id, userId, admin.session.userId);
  if (!facts) return { error: "That person is not a member of this project." };
  if (!facts.can.resetPassword) return { error: "This login is also used outside this project, so only a Main Admin can reset its password." };
  if (newPassword.length < MIN_PASSWORD_LENGTH) return { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  await platformPrisma.$transaction([
    platformPrisma.user.update({ where: { id: userId }, data: { passwordHash: hashPassword(newPassword) } }),
    platformPrisma.userSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: "PASSWORD_CHANGED" } }),
  ]);
  await logSystemEvent("WARN", "users", "PASSWORD_RESET", { actorId: admin.session.userId, targetUserId: userId, from: "project-members" });
  return { success: "Password reset. Every existing session for this member has been signed out." };
}

/** Only for a login that exists for this project alone (or by a Main Admin). Deactivating signs them out everywhere. */
export async function setProjectMemberActive(userId: string, isActive: boolean): Promise<ProjectAdminState> {
  const admin = await membersAdmin();
  if ("denied" in admin) return { error: admin.denied };
  const facts = await memberFacts(admin.project.id, userId, admin.session.userId);
  if (!facts) return { error: "That person is not a member of this project." };
  if (!facts.can.setActive) return { error: "This login is also used outside this project, so only a Main Admin can deactivate it." };
  if (facts.user.isActive === isActive) return { success: "No change." };
  if (isActive) {
    await platformPrisma.user.update({ where: { id: userId }, data: { isActive: true } });
  } else {
    await platformPrisma.$transaction([
      platformPrisma.user.update({ where: { id: userId }, data: { isActive: false } }),
      platformPrisma.userSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: "ADMIN_REVOKED" } }),
    ]);
  }
  forgetProjectAccessDecisions();
  await logSystemEvent("INFO", "users", isActive ? "USER_ENABLED" : "USER_DISABLED", { actorId: admin.session.userId, targetUserId: userId, from: "project-members" });
  await refreshMembers();
  return { success: isActive ? "Reactivated." : "Deactivated and signed out everywhere." };
}

/**
 * A role is saved as the pages it opens (`sectionAccess`) and the keys those pages need
 * (`permissionKeys`), the second DERIVED from the first on the server — never taken from the form — so
 * the two cannot disagree and no key a page does not need can be smuggled in. "Fine-tune" can only
 * hold back a write key of a Full page, never add one; whatever is submitted is sanitised again.
 */
function roleFields(form: FormData) {
  let submitted: unknown = null;
  try {
    submitted = JSON.parse(String(form.get("sectionAccess") ?? "null"));
  } catch {
    submitted = null;
  }
  const sectionAccess = sanitizeSectionAccess(submitted);
  return {
    name: String(form.get("name") ?? "").trim(),
    description: String(form.get("description") ?? "").trim() || null,
    sectionAccess,
    permissionKeys: keysForSectionAccess(sectionAccess, form.getAll("excludedKeys").map(String)),
  };
}

function pagesSummary(fields: ReturnType<typeof roleFields>) {
  const levels = Object.values(fields.sectionAccess);
  return { keys: fields.permissionKeys.length, pages: levels.length, full: levels.filter((l) => l === "FULL").length };
}

export async function createProjectRole(_prev: ProjectAdminState, form: FormData): Promise<ProjectAdminState> {
  const admin = await rolesAdmin();
  if ("denied" in admin) return { error: admin.denied };
  const fields = roleFields(form);
  if (!fields.name) return { error: "Name is required." };
  if (fields.name.length > 80) return { error: "Keep the name under 80 characters." };
  if (await prisma.projectRole.findFirst({ where: { name: fields.name }, select: { id: true } })) {
    return { error: `This project already has a role named "${fields.name}".` };
  }
  try {
    const role = await prisma.projectRole.create({ data: { projectId: admin.project.id, ...fields }, select: { id: true } });
    await logSystemEvent("INFO", "permissions", "PROJECT_ROLE_CREATED", { actorId: admin.session.userId, projectRoleId: role.id, ...pagesSummary(fields) });
  } catch (err) {
    if (isUniqueViolation(err)) return { error: `This project already has a role named "${fields.name}".` };
    throw err;
  }
  revalidatePath(await projectPath("/project-roles"));
  redirect(await projectPath("/project-roles"));
}

export async function updateProjectRole(id: string, _prev: ProjectAdminState, form: FormData): Promise<ProjectAdminState> {
  const admin = await rolesAdmin();
  if ("denied" in admin) return { error: admin.denied };
  const existing = await prisma.projectRole.findFirst({ where: { id }, select: { id: true, name: true } });
  if (!existing) return { error: "That project role no longer exists in this project." };
  const fields = roleFields(form);
  if (!fields.name) return { error: "Name is required." };
  if (fields.name.length > 80) return { error: "Keep the name under 80 characters." };
  if (fields.name !== existing.name && (await prisma.projectRole.findFirst({ where: { name: fields.name }, select: { id: true } }))) {
    return { error: `This project already has a role named "${fields.name}".` };
  }
  try {
    await prisma.projectRole.update({ where: { id }, data: fields });
  } catch (err) {
    if (isUniqueViolation(err)) return { error: `This project already has a role named "${fields.name}".` };
    throw err;
  }
  await logSystemEvent("WARN", "permissions", "PROJECT_ROLE_UPDATED", { actorId: admin.session.userId, projectRoleId: id, ...pagesSummary(fields) });
  revalidatePath(await projectPath("/project-roles"));
  revalidatePath(await projectPath("/project-members"));
  redirect(await projectPath("/project-roles"));
}

/** Refused while anybody holds the role: give them another one first, so nobody silently loses access. */
export async function deleteProjectRole(id: string): Promise<ProjectAdminState> {
  const admin = await rolesAdmin();
  if ("denied" in admin) return { error: admin.denied };
  const role = await prisma.projectRole.findFirst({ where: { id }, select: { id: true, name: true, _count: { select: { members: true } } } });
  if (!role) return { error: "That project role no longer exists in this project." };
  if (role._count.members > 0) return { error: `"${role.name}" is still given to ${role._count.members} member(s). Give them another role first.` };
  await prisma.projectRole.delete({ where: { id } });
  await logSystemEvent("WARN", "permissions", "PROJECT_ROLE_DELETED", { actorId: admin.session.userId, projectRoleId: id, name: role.name });
  revalidatePath(await projectPath("/project-roles"));
  return { success: `"${role.name}" deleted.` };
}
