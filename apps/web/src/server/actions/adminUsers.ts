"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isProjectAccessLevel, PROJECT_ACCESS_LEVEL_LABELS, type ProjectAccessLevelValue } from "@support-automation/shared";
import { platformPrisma } from "@/server/db";
import { requireSession } from "@/server/auth";
import { hasPermission } from "@/server/permissions";
import { forgetProjectAccessDecisions } from "@/server/projectContext";
import { logSystemEvent } from "@/server/logSystemEvent";
import { createUserWithAccess, setUserProjectAccess, type AccessGrant, type NewUserInput } from "@/server/adminUsers";
import { linkEmployeeToUser } from "@/server/configuration";
import { privilegeRefusal } from "@/server/privilegeGuard";

/**
 * Main Admin → Users & Permissions actions (MAIN_ADMIN_WORKSPACE.md §5). Every part is checked with
 * the EXISTING key for that part, never a new catch-all:
 *
 *   create the login     users.create        (as on the portal's App Users page)
 *   change the role      users.edit
 *   project access       projects.manage     (as on a project's page under Projects)
 *   the employee record  configuration.manage
 *
 * and all of it needs the Main Admin Portal key, `projects.view`, since that is where the page lives.
 */

export interface AdminUserFormState {
  error?: string;
  success?: string;
}

const NEEDS = (what: string) => `You do not have permission to ${what}.`;

async function portalSession() {
  const session = await requireSession();
  return (await hasPermission(session, "projects.view")) ? session : null;
}

export async function createUserFromAdmin(_prev: AdminUserFormState, form: FormData): Promise<AdminUserFormState> {
  const session = await portalSession();
  if (!session || !(await hasPermission(session, "users.create"))) return { error: NEEDS("create users") };

  const access: AccessGrant[] = [];
  for (const [name, value] of form.entries()) {
    if (!name.startsWith("access:")) continue;
    const level = String(value);
    if (level === "NONE" || level === "") continue;
    if (!isProjectAccessLevel(level)) return { error: "Choose No access, Read, Write or Full for each project." };
    access.push({ projectId: name.slice("access:".length), level });
  }
  if (access.length > 0 && !(await hasPermission(session, "projects.manage"))) {
    return { error: NEEDS("give project access (Manage Projects and Project Access)") };
  }

  const roleId = String(form.get("permissionModuleId") ?? "").trim() || null;
  const privileged = await privilegeRefusal(session.userId, { assignsRoleId: roleId });
  if (privileged) return { error: privileged };

  const mode = String(form.get("employeeMode") ?? "none");
  let employee: NewUserInput["employee"] = null;
  if (mode === "existing" || mode === "new") {
    if (!(await hasPermission(session, "configuration.manage"))) return { error: NEEDS("record employees (Manage Departments, Job Titles & Employees)") };
    employee =
      mode === "existing"
        ? { existingId: String(form.get("employeeId") ?? "") }
        : {
            create: {
              fullName: form.get("emp_fullName") || form.get("name"),
              email: form.get("emp_email"),
              phone: form.get("emp_phone"),
              departmentId: form.get("emp_departmentId"),
              jobTitleId: form.get("emp_jobTitleId"),
              joinedOn: form.get("emp_joinedOn"),
            },
          };
    if (mode === "existing" && !String(form.get("employeeId") ?? "")) return { error: "Choose the employee this login belongs to." };
  }

  const result = await createUserWithAccess(platformPrisma, {
    username: form.get("username"),
    name: form.get("name"),
    email: form.get("email"),
    password: form.get("password"),
    confirmPassword: form.get("confirmPassword"),
    permissionModuleId: form.get("permissionModuleId"),
    employee,
    access,
  });
  if (!result.ok) return { error: result.error };

  forgetProjectAccessDecisions();
  await logSystemEvent("INFO", "users", "USER_CREATED", {
    actorId: session.userId,
    targetUserId: result.userId,
    projects: access.map((a) => `${a.projectId}:${a.level}`),
    employeeCode: result.employeeCode ?? null,
    from: "main-admin",
  });
  revalidatePath("/admin/users");
  redirect(`/admin/users/${result.userId}?created=1`);
}

/** No access, or a level. Removing access takes effect on the user's next request (the decision cache is cleared). */
export async function setUserAccessLevel(userId: string, projectId: string, levelRaw: string): Promise<AdminUserFormState> {
  const session = await portalSession();
  if (!session || !(await hasPermission(session, "projects.manage"))) return { error: NEEDS("change project access") };
  const level: ProjectAccessLevelValue | null = levelRaw === "NONE" ? null : isProjectAccessLevel(levelRaw) ? levelRaw : null;
  if (levelRaw !== "NONE" && level === null) return { error: "Choose No access, Read, Write or Full." };

  const result = await setUserProjectAccess(platformPrisma, userId, projectId, level);
  if (!result.ok) return { error: result.error };
  forgetProjectAccessDecisions();
  if (result.changed !== "unchanged") {
    await logSystemEvent("WARN", "projects", `Project access ${result.changed}`, { projectId, userId, level: level ?? "NONE", changedBy: session.username });
  }
  revalidatePath(`/admin/users/${userId}`);
  revalidatePath("/admin/users");
  revalidatePath(`/admin/projects/${projectId}`);
  return {
    success:
      result.changed === "removed"
        ? "Access removed."
        : result.changed === "unchanged"
          ? "No change."
          : `Access set to ${PROJECT_ACCESS_LEVEL_LABELS[level ?? "FULL"]}.`,
  };
}

/** The user's role — the existing Permission Module. */
export async function setUserRole(userId: string, permissionModuleIdRaw: string): Promise<AdminUserFormState> {
  const session = await portalSession();
  if (!session || !(await hasPermission(session, "users.edit"))) return { error: NEEDS("change a user's role") };
  const permissionModuleId = permissionModuleIdRaw || null;
  if (userId === session.userId) return { error: "You cannot change your own role — ask another administrator." };
  const [user, role] = await Promise.all([
    platformPrisma.user.findUnique({ where: { id: userId }, select: { id: true } }),
    permissionModuleId ? platformPrisma.permissionModule.findUnique({ where: { id: permissionModuleId }, select: { id: true, name: true } }) : null,
  ]);
  if (!user) return { error: "That user no longer exists." };
  if (permissionModuleId && !role) return { error: "That role no longer exists." };
  const privileged = await privilegeRefusal(session.userId, { assignsRoleId: permissionModuleId, targetUserId: userId });
  if (privileged) return { error: privileged };
  await platformPrisma.user.update({ where: { id: userId }, data: { permissionModuleId } });
  // A role can make or unmake a Main Admin, which decides project entry: forget cached decisions.
  forgetProjectAccessDecisions();
  await logSystemEvent("WARN", "users", "USER_ROLE_CHANGED", { actorId: session.userId, targetUserId: userId, role: role?.name ?? null });
  revalidatePath(`/admin/users/${userId}`);
  revalidatePath("/admin/users");
  return { success: role ? `Role set to ${role.name}.` : "Role removed." };
}

/** Links (or unlinks, with null) the employee record behind a login. */
export async function setUserEmployee(userId: string, employeeId: string | null): Promise<AdminUserFormState> {
  const session = await portalSession();
  if (!session || !(await hasPermission(session, "configuration.manage"))) return { error: NEEDS("link employees (Manage Departments, Job Titles & Employees)") };
  if (employeeId === null) {
    const current = await platformPrisma.employee.findUnique({ where: { userId }, select: { id: true } });
    if (!current) return { success: "No employee was linked." };
    const result = await linkEmployeeToUser(platformPrisma, current.id, null);
    if (!result.ok) return { error: result.error };
  } else {
    const result = await linkEmployeeToUser(platformPrisma, employeeId, userId);
    if (!result.ok) return { error: result.error };
  }
  await logSystemEvent("INFO", "users", employeeId ? "USER_EMPLOYEE_LINKED" : "USER_EMPLOYEE_UNLINKED", { actorId: session.userId, targetUserId: userId, employeeId });
  revalidatePath(`/admin/users/${userId}`);
  revalidatePath("/admin/users");
  return { success: employeeId ? "Employee linked." : "Employee unlinked." };
}
