"use server";

import { revalidatePath } from "next/cache";
import { moduleDefinition, type ModuleIssue } from "@support-automation/shared";
import { platformPrisma } from "@/server/db";
import { requireSession, type Session } from "@/server/auth";
import { hasPermission } from "@/server/permissions";
import { forgetProjectFeatureStates } from "@/server/projectFeatures";
import { logSystemEvent } from "@/server/logSystemEvent";
import { applyModuleSelection, findModuleTemplate, type ApplyModuleSelectionResult } from "@/server/projectModules";

/**
 * The Module Builder's actions (PROJECT_MODULES.md §5). Each checks `projects.manage` itself (a Server
 * Action is a public endpoint) and applies through `applyModuleSelection` with the customer-scoped
 * client, so a customer's Main Admin reaches only its own projects and templates. Nothing is deleted,
 * no WhatsApp session is touched, and a type grants no plan feature and no permission.
 */

export interface ApplyModulesResult {
  error?: string;
  issues?: ModuleIssue[];
  success?: string;
  version?: number;
}

const MANAGE_DENIED = "Changing a project's modules needs the “Manage Projects and Project Access” permission.";

async function requireManage(): Promise<Session | null> {
  const session = await requireSession();
  return (await hasPermission(session, "projects.manage")) ? session : null;
}

const names = (keys: readonly string[] | undefined) => (keys ?? []).map((k) => moduleDefinition(k)?.name ?? k).join(", ") || "none";

async function afterApply(projectId: string, session: Session, result: ApplyModuleSelectionResult, reason: string | null, template: string | null): Promise<ApplyModulesResult> {
  if (result.error) return { error: result.error, issues: result.issues };
  if (result.added?.length === 0 && result.removed?.length === 0 && result.success?.startsWith("Nothing")) return { success: result.success, version: result.version };
  forgetProjectFeatureStates();
  const project = await platformPrisma.project.findUnique({ where: { id: projectId }, select: { name: true } });
  await logSystemEvent("WARN", "projects", `Modules changed for "${project?.name ?? projectId}" (v${result.version})`, {
    projectId,
    projectType: result.projectType,
    projectBaseType: result.projectBaseType,
    added: result.added,
    removed: result.removed,
    autoAdded: result.autoAdded,
    template,
    reason,
    changedBy: session.username,
  });
  revalidatePath(`/admin/projects/${projectId}`);
  revalidatePath(`/admin/projects/${projectId}/modules`);
  return { success: `Applied. Switched on: ${names(result.added)}. Switched off (data kept): ${names(result.removed)}.`, version: result.version };
}

function readInput(input: { modules: unknown; declined: unknown; expectedVersion: unknown }): string | null {
  if (!Array.isArray(input.modules) || !Array.isArray(input.declined) || input.modules.length > 200 || input.declined.length > 200) return "That selection could not be read.";
  if (!Number.isInteger(input.expectedVersion) || (input.expectedVersion as number) < 0) return "That selection could not be read.";
  return null;
}

export async function applyProjectModules(
  projectId: string,
  input: { modules: string[]; declined: string[]; baseType: string | null; expectedVersion: number; reason: string; templateKey?: string | null },
): Promise<ApplyModulesResult> {
  const session = await requireManage();
  if (!session) return { error: MANAGE_DENIED };
  const bad = readInput(input);
  if (bad) return { error: bad };
  const reason = String(input.reason ?? "").trim().slice(0, 500) || null;

  // A template named by the browser is looked up again, among this customer's own: its version is
  // recorded, and an unknown or another customer's template is simply not recorded.
  let template: { key: string; version: number } | null = null;
  if (input.templateKey) {
    const project = await platformPrisma.project.findUnique({ where: { id: projectId }, select: { customerId: true } });
    const found = project ? await findModuleTemplate(String(input.templateKey), project.customerId) : null;
    if (found) template = { key: found.key, version: found.version };
  }
  const result = await applyModuleSelection(platformPrisma, {
    projectId,
    modules: input.modules,
    declined: input.declined,
    baseType: input.baseType,
    expectedVersion: input.expectedVersion,
    reason,
    actor: session.username,
    template,
  });
  return afterApply(projectId, session, result, reason, template?.key ?? null);
}

/** Re-apply an earlier configuration through the same validation (never by writing rows directly). */
export async function restoreProjectModules(projectId: string, changeId: string, expectedVersion: number): Promise<ApplyModulesResult> {
  const session = await requireManage();
  if (!session) return { error: MANAGE_DENIED };
  const change = await platformPrisma.projectModuleConfigChange.findFirst({ where: { id: changeId, projectId }, select: { version: true, modules: true, declined: true, projectBaseType: true } });
  if (!change) return { error: "That earlier configuration no longer exists." };
  const reason = `Restored configuration v${change.version}`;
  const result = await applyModuleSelection(platformPrisma, {
    projectId,
    modules: change.modules,
    declined: change.declined,
    baseType: change.projectBaseType,
    expectedVersion,
    reason,
    actor: session.username,
  });
  return afterApply(projectId, session, result, reason, null);
}
