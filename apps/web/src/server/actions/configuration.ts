"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { PermissionKey } from "@support-automation/shared";
import { platformPrisma } from "@/server/db";
import { requireSession, type Session } from "@/server/auth";
import { hasPermission } from "@/server/permissions";
import { logSystemEvent } from "@/server/logSystemEvent";
import {
  createDepartment,
  createEmployee,
  createJobTitle,
  deleteDepartment,
  deleteJobTitle,
  linkEmployeeToUser,
  setDepartmentActive,
  setEmployeeStatus,
  setJobTitleActive,
  updateDepartment,
  updateEmployee,
  updateJobTitle,
  type ConfigResult,
} from "@/server/configuration";

/**
 * Main Admin → Configuration actions (MAIN_ADMIN_WORKSPACE.md §5). Each is a public endpoint, so each
 * checks for itself: the Main Admin Portal key (`projects.view`) and `configuration.manage`. The rules
 * live in `server/configuration.ts`.
 */

export interface ConfigFormState {
  error?: string;
  success?: string;
}

const DENIED = "You do not have permission to change Configuration. It needs Manage Departments, Job Titles & Employees.";

async function gate(key: PermissionKey = "configuration.manage"): Promise<{ session: Session } | { denied: string }> {
  const session = await requireSession();
  if (!(await hasPermission(session, "projects.view")) || !(await hasPermission(session, key))) return { denied: DENIED };
  return { session };
}

async function done(result: ConfigResult, session: Session, event: string, path: string, success: string): Promise<ConfigFormState> {
  if (!result.ok) return { error: result.error };
  await logSystemEvent("INFO", "configuration", event, { targetId: result.id, changedBy: session.username });
  revalidatePath(path);
  return { success };
}

// ── Departments ──────────────────────────────────────────────────────────────────────────────────

export async function saveDepartment(_prev: ConfigFormState, form: FormData): Promise<ConfigFormState> {
  const g = await gate();
  if ("denied" in g) return { error: g.denied };
  const id = String(form.get("id") ?? "");
  const input = { name: form.get("name"), code: form.get("code"), description: form.get("description") };
  const result = id ? await updateDepartment(platformPrisma, id, input) : await createDepartment(platformPrisma, input);
  return done(result, g.session, id ? "DEPARTMENT_UPDATED" : "DEPARTMENT_CREATED", "/admin/configuration/departments", id ? "Department saved." : "Department added.");
}

export async function toggleDepartment(id: string, isActive: boolean): Promise<ConfigFormState> {
  const g = await gate();
  if ("denied" in g) return { error: g.denied };
  return done(await setDepartmentActive(platformPrisma, id, isActive), g.session, isActive ? "DEPARTMENT_ACTIVATED" : "DEPARTMENT_DEACTIVATED", "/admin/configuration/departments", isActive ? "Department reactivated." : "Department deactivated.");
}

export async function removeDepartment(id: string): Promise<ConfigFormState> {
  const g = await gate();
  if ("denied" in g) return { error: g.denied };
  return done(await deleteDepartment(platformPrisma, id), g.session, "DEPARTMENT_DELETED", "/admin/configuration/departments", "Department deleted.");
}

// ── Job titles ───────────────────────────────────────────────────────────────────────────────────

export async function saveJobTitle(_prev: ConfigFormState, form: FormData): Promise<ConfigFormState> {
  const g = await gate();
  if ("denied" in g) return { error: g.denied };
  const id = String(form.get("id") ?? "");
  const input = { name: form.get("name"), description: form.get("description") };
  const result = id ? await updateJobTitle(platformPrisma, id, input) : await createJobTitle(platformPrisma, input);
  return done(result, g.session, id ? "JOB_TITLE_UPDATED" : "JOB_TITLE_CREATED", "/admin/configuration/job-titles", id ? "Job title saved." : "Job title added.");
}

export async function toggleJobTitle(id: string, isActive: boolean): Promise<ConfigFormState> {
  const g = await gate();
  if ("denied" in g) return { error: g.denied };
  return done(await setJobTitleActive(platformPrisma, id, isActive), g.session, isActive ? "JOB_TITLE_ACTIVATED" : "JOB_TITLE_DEACTIVATED", "/admin/configuration/job-titles", isActive ? "Job title reactivated." : "Job title deactivated.");
}

export async function removeJobTitle(id: string): Promise<ConfigFormState> {
  const g = await gate();
  if ("denied" in g) return { error: g.denied };
  return done(await deleteJobTitle(platformPrisma, id), g.session, "JOB_TITLE_DELETED", "/admin/configuration/job-titles", "Job title deleted.");
}

// ── Employees ────────────────────────────────────────────────────────────────────────────────────

function employeeInput(form: FormData) {
  return {
    fullName: form.get("fullName"),
    email: form.get("email"),
    phone: form.get("phone"),
    departmentId: form.get("departmentId"),
    jobTitleId: form.get("jobTitleId"),
    joinedOn: form.get("joinedOn"),
  };
}

export async function saveEmployee(_prev: ConfigFormState, form: FormData): Promise<ConfigFormState> {
  const g = await gate();
  if ("denied" in g) return { error: g.denied };
  const id = String(form.get("id") ?? "");
  const result = id ? await updateEmployee(platformPrisma, id, employeeInput(form)) : await createEmployee(platformPrisma, employeeInput(form));
  if (!result.ok) return { error: result.error };
  await logSystemEvent("INFO", "configuration", id ? "EMPLOYEE_UPDATED" : "EMPLOYEE_CREATED", { targetId: result.id, changedBy: g.session.username });
  revalidatePath("/admin/configuration/employees");
  redirect(`/admin/configuration/employees/${result.id}?saved=1`);
}

export async function toggleEmployee(id: string, active: boolean): Promise<ConfigFormState> {
  const g = await gate();
  if ("denied" in g) return { error: g.denied };
  return done(
    await setEmployeeStatus(platformPrisma, id, active ? "ACTIVE" : "INACTIVE"),
    g.session,
    active ? "EMPLOYEE_ACTIVATED" : "EMPLOYEE_DEACTIVATED",
    `/admin/configuration/employees/${id}`,
    active ? "Employee reactivated." : "Employee deactivated. Their login, if any, is unchanged — deactivate it separately if they have left.",
  );
}

export async function linkEmployeeLogin(employeeId: string, userId: string | null): Promise<ConfigFormState> {
  const g = await gate();
  if ("denied" in g) return { error: g.denied };
  const result = await linkEmployeeToUser(platformPrisma, employeeId, userId);
  if (!result.ok) return { error: result.error };
  await logSystemEvent("INFO", "configuration", userId ? "EMPLOYEE_LOGIN_LINKED" : "EMPLOYEE_LOGIN_UNLINKED", { targetId: employeeId, userId, changedBy: g.session.username });
  revalidatePath(`/admin/configuration/employees/${employeeId}`);
  revalidatePath("/admin/users");
  return { success: userId ? "Login linked." : "Login unlinked." };
}
