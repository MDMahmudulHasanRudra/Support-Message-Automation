"use server";

import { revalidatePath } from "next/cache";
import {
  isProjectType,
  moduleDefinition,
  moduleSelectionDiff,
  PROJECT_MODULES,
  resolveModuleSelection,
  typeForSelection,
  type ModuleIssue,
  type ProjectBaseType,
} from "@support-automation/shared";
import { platformPrisma } from "@/server/db";
import { requireSession } from "@/server/auth";
import { hasPermission } from "@/server/permissions";
import { forgetProjectFeatureStates } from "@/server/projectFeatures";
import { logSystemEvent } from "@/server/logSystemEvent";
import { enabledModuleKeys, projectEntitlement } from "@/server/projectModules";

/**
 * Applying a module configuration (PROJECT_MODULES.md §4, §7). The browser sends what it wants; this
 * resolves it again on the server with the same pure rules (`resolveModuleSelection`), so a removed
 * hard dependency comes back and nothing invalid can be saved. Then, in ONE transaction:
 *
 *   - the project's version moves from the one the admin saw to the next, or the change is refused
 *     (two admins cannot overwrite each other unseen);
 *   - only the `ProjectFeature` rows whose value changes are written — the same switches every page,
 *     action and worker loop already obey, so "frozen" means exactly what switching a feature off has
 *     always meant: the module's pages and actions refuse, its background work stops, its data stays;
 *   - one append-only history row records before, after, auto-added, declined, who and why.
 *
 * Nothing is deleted, no WhatsApp session is touched, and a type is a label: it grants no plan feature
 * and no permission.
 */

export interface ApplyModulesResult {
  error?: string;
  issues?: ModuleIssue[];
  success?: string;
  version?: number;
}

const MANAGE_DENIED = "Changing a project's modules needs the “Manage Projects and Project Access” permission.";

export async function applyProjectModules(
  projectId: string,
  input: { modules: string[]; declined: string[]; baseType: string | null; expectedVersion: number; reason: string },
): Promise<ApplyModulesResult> {
  const session = await requireSession();
  if (!(await hasPermission(session, "projects.manage"))) return { error: MANAGE_DENIED };
  if (!Array.isArray(input.modules) || !Array.isArray(input.declined) || input.modules.length > 200 || input.declined.length > 200) return { error: "That selection could not be read." };
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) return { error: "That selection could not be read." };
  const baseType = input.baseType && isProjectType(input.baseType) && input.baseType !== "CUSTOM_MIX" ? (input.baseType as ProjectBaseType) : null;
  const reason = String(input.reason ?? "").trim().slice(0, 500) || null;

  const project = await platformPrisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true, customerId: true, moduleConfigVersion: true, projectType: true, projectBaseType: true, features: { select: { key: true, enabled: true } } },
  });
  if (!project) return { error: "That project no longer exists." };
  if (project.moduleConfigVersion !== input.expectedVersion) return { error: "Somebody changed this project's modules while you were editing. Reload to see their change, then apply yours again." };

  const before = enabledModuleKeys(project.features);
  const { entitlement } = await projectEntitlement(project.customerId);
  const resolved = resolveModuleSelection({ requested: input.modules.map(String), declined: input.declined.map(String), entitlement, currentlyEnabled: before });
  if (!resolved.ok) return { error: "This configuration cannot be applied as it is.", issues: resolved.issues };

  const { projectType, baseType: recordedBase } = typeForSelection(resolved.selected, baseType);
  const diff = moduleSelectionDiff(before, resolved.selected);
  if (diff.added.length === 0 && diff.removed.length === 0 && projectType === project.projectType && recordedBase === project.projectBaseType) {
    return { success: "Nothing to change: this is already the project's configuration.", version: project.moduleConfigVersion };
  }

  const selected = new Set(resolved.selected);
  const changes = PROJECT_MODULES.filter((m) => m.status === "AVAILABLE" && m.featureKey && selected.has(m.key) !== before.includes(m.key));
  const nextVersion = project.moduleConfigVersion + 1;
  try {
    await platformPrisma.$transaction(async (tx) => {
      const moved = await tx.project.updateMany({
        where: { id: projectId, moduleConfigVersion: input.expectedVersion },
        data: { projectType, projectBaseType: recordedBase, moduleConfigVersion: nextVersion },
      });
      if (moved.count !== 1) throw new StaleVersion();
      for (const m of changes) {
        const enabled = selected.has(m.key);
        await tx.projectFeature.upsert({
          where: { projectId_key: { projectId, key: m.featureKey! } },
          update: { enabled },
          create: { projectId, key: m.featureKey!, enabled },
        });
      }
      await tx.projectModuleConfigChange.create({
        data: {
          projectId,
          version: nextVersion,
          projectType,
          projectBaseType: recordedBase,
          previousModules: before,
          modules: resolved.selected,
          autoAdded: [...new Set(resolved.autoAdded.map((a) => a.key))],
          declined: resolved.declined,
          reason,
          actorUsername: session.username,
        },
      });
    });
  } catch (err) {
    if (err instanceof StaleVersion) return { error: "Somebody changed this project's modules while you were editing. Reload to see their change, then apply yours again." };
    throw err;
  }

  forgetProjectFeatureStates();
  const names = (keys: string[]) => keys.map((k) => moduleDefinition(k)?.name ?? k).join(", ") || "none";
  await logSystemEvent("WARN", "projects", `Modules changed for "${project.name}" (v${nextVersion})`, {
    projectId,
    projectType,
    projectBaseType: recordedBase,
    added: diff.added,
    removed: diff.removed,
    autoAdded: resolved.autoAdded.map((a) => a.key),
    declined: resolved.declined,
    reason,
    changedBy: session.username,
  });
  revalidatePath(`/admin/projects/${projectId}`);
  revalidatePath(`/admin/projects/${projectId}/modules`);
  return { success: `Applied. Switched on: ${names(diff.added)}. Switched off (data kept): ${names(diff.removed)}.`, version: nextVersion };
}

/** Re-apply an earlier configuration through the same validation (never by writing rows directly). */
export async function restoreProjectModules(projectId: string, changeId: string, expectedVersion: number): Promise<ApplyModulesResult> {
  const session = await requireSession();
  if (!(await hasPermission(session, "projects.manage"))) return { error: MANAGE_DENIED };
  const change = await platformPrisma.projectModuleConfigChange.findFirst({ where: { id: changeId, projectId }, select: { version: true, modules: true, declined: true, projectBaseType: true } });
  if (!change) return { error: "That earlier configuration no longer exists." };
  return applyProjectModules(projectId, {
    modules: change.modules,
    declined: change.declined,
    baseType: change.projectBaseType,
    expectedVersion,
    reason: `Restored configuration v${change.version}`,
  });
}

class StaleVersion extends Error {}
