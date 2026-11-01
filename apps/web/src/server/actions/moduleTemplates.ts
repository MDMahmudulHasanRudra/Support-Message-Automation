"use server";

import { revalidatePath } from "next/cache";
import { builtInModuleTemplate, isProjectType, resolveModuleSelection, type ModuleIssue, TEMPLATE_ENTITLEMENT } from "@support-automation/shared";
import { platformPrisma } from "@/server/db";
import { requireSession, type Session } from "@/server/auth";
import { hasPermission } from "@/server/permissions";
import { logSystemEvent } from "@/server/logSystemEvent";
import { isUniqueViolation } from "@/lib/prismaErrors";

/**
 * A customer's own module templates (PROJECT_MODULES.md §8). Every action needs `projects.manage` and
 * goes through the customer-scoped client, which stores and finds a template only under the customer
 * of the request — one customer can never see, edit or apply another's. Built-in templates live in code
 * and can only be duplicated.
 *
 * A template is a selection, not a plan: it is checked against the module rules (no planned or unknown
 * module, hard dependencies included) but not against any plan. The plan applies when the template is
 * applied to a project. Editing bumps `version`; a project keeps what it applied.
 */

export interface ModuleTemplateResult {
  error?: string;
  fieldErrors?: { name?: string };
  issues?: ModuleIssue[];
  success?: string;
  id?: string;
}

const DENIED = "Managing module templates needs the “Manage Projects and Project Access” permission.";
// A template only lists modules; applying it is checked against the project (MODULE_APPROVALS.md).
const OPEN = TEMPLATE_ENTITLEMENT;

async function requireManage(): Promise<Session | null> {
  const session = await requireSession();
  return (await hasPermission(session, "projects.manage")) ? session : null;
}

function readFields(input: { name: unknown; description: unknown; baseType: unknown; modules: unknown; declined: unknown }) {
  const name = String(input.name ?? "").replace(/\s+/g, " ").trim();
  const description = String(input.description ?? "").trim().slice(0, 500) || null;
  const baseType = isProjectType(input.baseType) && input.baseType !== "CUSTOM_MIX" ? input.baseType : null;
  const modules = Array.isArray(input.modules) ? input.modules.map(String).slice(0, 200) : null;
  const declined = Array.isArray(input.declined) ? input.declined.map(String).slice(0, 200) : [];
  return { name, description, baseType, modules, declined };
}

export async function saveModuleTemplate(
  id: string | null,
  input: { name: string; description: string; baseType: string; modules: string[]; declined: string[]; expectedVersion?: number },
): Promise<ModuleTemplateResult> {
  const session = await requireManage();
  if (!session) return { error: DENIED };
  const f = readFields(input);
  if (f.name.length < 2 || f.name.length > 80) return { fieldErrors: { name: "Give the template a name of 2 to 80 characters." } };
  if (!f.baseType) return { error: "Choose the business type the template is based on." };
  if (!f.modules || f.modules.length === 0) return { error: "Choose at least one module." };
  const resolved = resolveModuleSelection({ requested: f.modules, declined: f.declined, entitlement: OPEN });
  if (!resolved.ok) return { error: "This template cannot be saved as it is.", issues: resolved.issues };

  const data = { name: f.name, description: f.description, baseType: f.baseType, modules: resolved.selected, declined: resolved.declined };
  try {
    if (id === null) {
      const row = await platformPrisma.moduleTemplate.create({ data: { ...data, createdByUsername: session.username }, select: { id: true } });
      await logSystemEvent("INFO", "projects", `Module template "${f.name}" created`, { templateId: row.id, modules: resolved.selected, by: session.username });
      revalidatePath("/admin/module-templates");
      return { success: `Saved "${f.name}".`, id: row.id };
    }
    const updated = await platformPrisma.moduleTemplate.updateMany({
      where: { id, archivedAt: null, ...(Number.isInteger(input.expectedVersion) ? { version: input.expectedVersion } : {}) },
      data: { ...data, version: { increment: 1 }, updatedByUsername: session.username },
    });
    if (updated.count !== 1) return { error: "This template was changed or archived by somebody else. Reload and try again." };
    await logSystemEvent("INFO", "projects", `Module template "${f.name}" edited`, { templateId: id, modules: resolved.selected, by: session.username });
    revalidatePath("/admin/module-templates");
    revalidatePath(`/admin/module-templates/${id}`);
    return { success: `Saved "${f.name}". Projects that applied an earlier version keep what they applied.`, id };
  } catch (err) {
    if (isUniqueViolation(err)) return { fieldErrors: { name: `A template called "${f.name}" already exists.` } };
    throw err;
  }
}

/** Copy a built-in or one of the customer's own templates into a new template of the customer's. */
export async function duplicateModuleTemplate(sourceKey: string): Promise<ModuleTemplateResult> {
  const session = await requireManage();
  if (!session) return { error: DENIED };
  const builtIn = builtInModuleTemplate(sourceKey);
  const own = builtIn ? null : await platformPrisma.moduleTemplate.findFirst({ where: { id: sourceKey } });
  const source = builtIn
    ? { name: builtIn.name, description: builtIn.description, baseType: builtIn.baseType, modules: [...builtIn.modules], declined: [] as string[] }
    : own
      ? { name: own.name, description: own.description, baseType: own.baseType, modules: own.modules, declined: own.declined }
      : null;
  if (!source) return { error: "That template no longer exists." };
  for (let n = 1; n <= 20; n++) {
    const name = `${source.name} (copy${n > 1 ? ` ${n}` : ""})`.slice(0, 80);
    try {
      const row = await platformPrisma.moduleTemplate.create({ data: { ...source, name, createdByUsername: session.username }, select: { id: true } });
      await logSystemEvent("INFO", "projects", `Module template "${name}" created as a copy of "${source.name}"`, { templateId: row.id, by: session.username });
      revalidatePath("/admin/module-templates");
      return { success: `Created "${name}".`, id: row.id };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  return { error: "Too many copies with that name already exist. Rename one first." };
}

/** Archive (stop offering) or bring back a template. Archiving never changes a project that used it. */
export async function setModuleTemplateArchived(id: string, archived: boolean): Promise<ModuleTemplateResult> {
  const session = await requireManage();
  if (!session) return { error: DENIED };
  try {
    const updated = await platformPrisma.moduleTemplate.updateMany({
      where: { id, archivedAt: archived ? null : { not: null } },
      data: { archivedAt: archived ? new Date() : null, updatedByUsername: session.username },
    });
    if (updated.count !== 1) return { error: archived ? "That template is already archived or no longer exists." : "That template is not archived." };
  } catch (err) {
    if (isUniqueViolation(err)) return { error: "Another template in use already has this name. Rename it first." };
    throw err;
  }
  await logSystemEvent("INFO", "projects", `Module template ${archived ? "archived" : "brought back"}`, { templateId: id, by: session.username });
  revalidatePath("/admin/module-templates");
  return { success: archived ? "Archived. Projects that used it keep their modules." : "Brought back." };
}
