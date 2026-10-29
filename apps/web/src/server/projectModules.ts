import type { ProjectType } from "@prisma/client";
import { resolveProjectFeatures, type ModuleEntitlement, type ProjectBaseType } from "@support-automation/shared";
import { platformPrisma } from "@/server/db";

/**
 * A project's module configuration, read for the Module Builder (PROJECT_MODULES.md). Through the
 * customer-scoped client, so a customer's Main Admin reads only its own projects. The modules ON are
 * read from the same `ProjectFeature` rows (and defaults) every gate reads — there is no second copy.
 */

export interface ProjectModuleChangeView {
  id: string;
  version: number;
  projectType: ProjectType;
  projectBaseType: ProjectType | null;
  previousModules: string[];
  modules: string[];
  autoAdded: string[];
  declined: string[];
  reason: string | null;
  actorUsername: string;
  createdAt: string;
}

export interface ProjectModuleState {
  projectId: string;
  projectName: string;
  projectType: ProjectType;
  projectBaseType: ProjectBaseType | null;
  version: number;
  enabled: string[];
  entitlement: ModuleEntitlement;
  /** Plan name for the review screen; null = no subscription (nothing is held back). */
  planName: string | null;
  history: ProjectModuleChangeView[];
}

/** The customer's plan as the module resolver needs it. No subscription, or All Access = unrestricted. */
export async function projectEntitlement(customerId: string | null): Promise<{ entitlement: ModuleEntitlement; planName: string | null }> {
  const owner = customerId ?? (await platformPrisma.customer.findFirst({ where: { isFounding: true }, select: { id: true } }))?.id ?? null;
  if (!owner) return { entitlement: { restricted: false, allowedFeatures: [] }, planName: null };
  const sub = await platformPrisma.subscription.findFirst({ where: { customerId: owner, endedAt: null }, select: { planName: true, features: true, allModules: true } });
  if (!sub) return { entitlement: { restricted: false, allowedFeatures: [] }, planName: null };
  return { entitlement: { restricted: !sub.allModules, allowedFeatures: sub.features }, planName: sub.planName };
}

export function enabledModuleKeys(rows: ReadonlyArray<{ key: string; enabled: boolean }>): string[] {
  return resolveProjectFeatures(rows).filter((f) => f.enabled).map((f) => f.key).sort();
}

export async function getProjectModuleState(projectId: string): Promise<ProjectModuleState | null> {
  const project = await platformPrisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true, customerId: true, projectType: true, projectBaseType: true, moduleConfigVersion: true, features: { select: { key: true, enabled: true } } },
  });
  if (!project) return null;
  const [{ entitlement, planName }, history] = await Promise.all([
    projectEntitlement(project.customerId),
    platformPrisma.projectModuleConfigChange.findMany({ where: { projectId }, orderBy: { version: "desc" }, take: 20 }),
  ]);
  return {
    projectId: project.id,
    projectName: project.name,
    projectType: project.projectType,
    projectBaseType: project.projectBaseType === "CUSTOM_MIX" ? null : (project.projectBaseType as ProjectBaseType | null),
    version: project.moduleConfigVersion,
    enabled: enabledModuleKeys(project.features),
    entitlement,
    planName,
    history: history.map((h) => ({ ...h, createdAt: h.createdAt.toISOString() })),
  };
}
