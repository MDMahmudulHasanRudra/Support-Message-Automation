import type { PrismaClient, ProjectType } from "@prisma/client";
import {
  BUILT_IN_MODULE_TEMPLATES,
  builtInModuleTemplate,
  isProjectType,
  moduleEntitled,
  moduleSelectionDiff,
  PROJECT_MODULES,
  resolveModuleSelection,
  resolveProjectFeatures,
  typeForSelection,
  type ModuleEntitlement,
  type ModuleIssue,
  type ProjectBaseType,
} from "@support-automation/shared";
import { platformPrisma } from "@/server/db";
import { tenantOfCustomer } from "@/server/tenant";

/**
 * A project's module configuration (PROJECT_MODULES.md): reading it for the Module Builder, and the ONE
 * function that changes it. The Module Builder, Create Project and the platform's customer
 * provisioning all apply through `applyModuleSelection`, each with its own client:
 *
 *   - the Main Admin Portal passes the customer-scoped client, so a customer reaches only its own projects;
 *   - the platform layer passes the unscoped client for the customer it is provisioning.
 *
 * The modules ON are the same `ProjectFeature` rows (and defaults) every gate reads — no second copy.
 * Callers check who is asking; this function checks nothing about the person.
 */

type Db = PrismaClient;

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
  templateKey: string | null;
  templateVersion: number | null;
  createdAt: string;
}

export interface ModuleTemplateOption {
  key: string;
  name: string;
  description: string | null;
  baseType: ProjectBaseType;
  modules: string[];
  declined: string[];
  version: number;
  builtIn: boolean;
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
  templates: ModuleTemplateOption[];
}

const asBase = (value: ProjectType | null): ProjectBaseType | null => (value === "DEFAULT" || value === "ECOMMERCE" ? value : null);

/** The owning customer of a project: its own, or the founding customer for the original installation's. */
async function ownerOf(db: Db, customerId: string | null): Promise<string | null> {
  return customerId ?? (await db.customer.findFirst({ where: { isFounding: true }, select: { id: true } }))?.id ?? null;
}

/** The customer's plan as the module resolver needs it. No subscription, or All Access = unrestricted. */
export async function projectEntitlement(customerId: string | null, db: Db = platformPrisma): Promise<{ entitlement: ModuleEntitlement; planName: string | null }> {
  const owner = await ownerOf(db, customerId);
  if (!owner) return { entitlement: { restricted: false, allowedFeatures: [] }, planName: null };
  const sub = await db.subscription.findFirst({ where: { customerId: owner, endedAt: null }, select: { planName: true, features: true, allModules: true } });
  if (!sub) return { entitlement: { restricted: false, allowedFeatures: [] }, planName: null };
  return { entitlement: { restricted: !sub.allModules, allowedFeatures: sub.features }, planName: sub.planName };
}

export function enabledModuleKeys(rows: ReadonlyArray<{ key: string; enabled: boolean }>): string[] {
  return resolveProjectFeatures(rows).filter((f) => f.enabled).map((f) => f.key).sort();
}

/**
 * Templates a customer may apply: the built-ins, then its own templates in use. `customerId` is the
 * template owner as stored (NULL = the original installation). Through the customer-scoped client the
 * filter is applied again by the client itself.
 */
export async function moduleTemplateOptions(customerId: string | null, db: Db = platformPrisma): Promise<ModuleTemplateOption[]> {
  const builtIns = BUILT_IN_MODULE_TEMPLATES.map(
    (t): ModuleTemplateOption => ({ key: t.key, name: t.name, description: t.description, baseType: t.baseType, modules: [...t.modules], declined: [], version: 1, builtIn: true }),
  );
  // Templates are stored under the customer's tenant key (null = the original installation).
  const own = await db.moduleTemplate.findMany({ where: { customerId: await tenantOfCustomer(customerId), archivedAt: null }, orderBy: { name: "asc" } });
  return [
    ...builtIns,
    ...own.map((t): ModuleTemplateOption => ({ key: t.id, name: t.name, description: t.description, baseType: asBase(t.baseType) ?? "DEFAULT", modules: t.modules, declined: t.declined, version: t.version, builtIn: false })),
  ];
}

/** One template by key, among those the customer may apply. */
export async function findModuleTemplate(key: string, customerId: string | null, db: Db = platformPrisma): Promise<ModuleTemplateOption | null> {
  const builtIn = builtInModuleTemplate(key);
  if (builtIn) return { key: builtIn.key, name: builtIn.name, description: builtIn.description, baseType: builtIn.baseType, modules: [...builtIn.modules], declined: [], version: 1, builtIn: true };
  if (!/^[a-z0-9]{10,40}$/i.test(key)) return null;
  const row = await db.moduleTemplate.findFirst({ where: { id: key, customerId: await tenantOfCustomer(customerId), archivedAt: null } });
  return row ? { key: row.id, name: row.name, description: row.description, baseType: asBase(row.baseType) ?? "DEFAULT", modules: row.modules, declined: row.declined, version: row.version, builtIn: false } : null;
}

export async function getProjectModuleState(projectId: string, db: Db = platformPrisma): Promise<ProjectModuleState | null> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true, customerId: true, projectType: true, projectBaseType: true, moduleConfigVersion: true, features: { select: { key: true, enabled: true } } },
  });
  if (!project) return null;
  const [{ entitlement, planName }, history, templates] = await Promise.all([
    projectEntitlement(project.customerId, db),
    db.projectModuleConfigChange.findMany({ where: { projectId }, orderBy: { version: "desc" }, take: 20 }),
    moduleTemplateOptions(project.customerId, db),
  ]);
  return {
    projectId: project.id,
    projectName: project.name,
    projectType: project.projectType,
    projectBaseType: asBase(project.projectBaseType),
    version: project.moduleConfigVersion,
    enabled: enabledModuleKeys(project.features),
    entitlement,
    planName,
    history: history.map((h) => ({ ...h, createdAt: h.createdAt.toISOString() })),
    templates,
  };
}

export interface ApplyModuleSelectionInput {
  projectId: string;
  modules: readonly string[];
  declined: readonly string[];
  baseType: string | null;
  expectedVersion: number;
  reason: string | null;
  actor: string;
  template?: { key: string; version: number } | null;
  /**
   * "strict" (the builder): anything the plan does not include is an error the admin must resolve.
   * "fitToPlan" (a new project): modules the plan does not include are left out and named in the
   * history's reason, so creating a project never fails because a template is larger than the plan.
   */
  mode?: "strict" | "fitToPlan";
}

export interface ApplyModuleSelectionResult {
  error?: string;
  issues?: ModuleIssue[];
  success?: string;
  version?: number;
  added?: string[];
  removed?: string[];
  autoAdded?: string[];
  leftOut?: string[];
  projectType?: ProjectType;
  projectBaseType?: ProjectType | null;
}

const STALE = "Somebody changed this project's modules while you were editing. Reload to see their change, then apply yours again.";
class StaleVersion extends Error {}

/**
 * Apply a module selection (PROJECT_MODULES.md §5): resolve it again with the shared rules (a removed
 * hard dependency comes back; nothing invalid is stored), then in ONE transaction move the version on
 * (or refuse a stale one), write only the feature rows whose value changes, and append one history row.
 */
export async function applyModuleSelection(db: Db, input: ApplyModuleSelectionInput): Promise<ApplyModuleSelectionResult> {
  const baseType = input.baseType && isProjectType(input.baseType) && input.baseType !== "CUSTOM_MIX" ? (input.baseType as ProjectBaseType) : null;
  const project = await db.project.findUnique({
    where: { id: input.projectId },
    select: { id: true, customerId: true, moduleConfigVersion: true, projectType: true, projectBaseType: true, features: { select: { key: true, enabled: true } } },
  });
  if (!project) return { error: "That project no longer exists." };
  if (project.moduleConfigVersion !== input.expectedVersion) return { error: STALE };

  const before = enabledModuleKeys(project.features);
  const { entitlement } = await projectEntitlement(project.customerId, db);
  let requested = [...new Set(input.modules.map(String))];
  let leftOut: string[] = [];
  if (input.mode === "fitToPlan") {
    leftOut = requested.filter((k) => !before.includes(k) && !moduleEntitled(entitlement, k));
    requested = requested.filter((k) => !leftOut.includes(k));
  }
  const resolved = resolveModuleSelection({ requested, declined: input.declined.map(String), entitlement, currentlyEnabled: before });
  if (!resolved.ok) return { error: "This configuration cannot be applied as it is.", issues: resolved.issues };

  const { projectType, baseType: recordedBase } = typeForSelection(resolved.selected, baseType);
  const diff = moduleSelectionDiff(before, resolved.selected);
  const autoAdded = [...new Set(resolved.autoAdded.map((a) => a.key))];
  if (diff.added.length === 0 && diff.removed.length === 0 && projectType === project.projectType && recordedBase === project.projectBaseType && !input.template) {
    return { success: "Nothing to change: this is already the project's configuration.", version: project.moduleConfigVersion, added: [], removed: [], autoAdded: [], leftOut, projectType, projectBaseType: recordedBase };
  }

  const selected = new Set(resolved.selected);
  const changes = PROJECT_MODULES.filter((m) => m.status === "AVAILABLE" && m.featureKey && selected.has(m.key) !== before.includes(m.key));
  const nextVersion = project.moduleConfigVersion + 1;
  const reason = [input.reason, leftOut.length ? `Not in the plan, left out: ${leftOut.join(", ")}` : null].filter(Boolean).join(" · ") || null;
  try {
    await db.$transaction(async (tx) => {
      const moved = await tx.project.updateMany({
        where: { id: input.projectId, moduleConfigVersion: input.expectedVersion },
        data: { projectType, projectBaseType: recordedBase, moduleConfigVersion: nextVersion },
      });
      if (moved.count !== 1) throw new StaleVersion();
      for (const m of changes) {
        const enabled = selected.has(m.key);
        await tx.projectFeature.upsert({
          where: { projectId_key: { projectId: input.projectId, key: m.featureKey! } },
          update: { enabled },
          create: { projectId: input.projectId, key: m.featureKey!, enabled },
        });
      }
      await tx.projectModuleConfigChange.create({
        data: {
          projectId: input.projectId,
          version: nextVersion,
          projectType,
          projectBaseType: recordedBase,
          previousModules: before,
          modules: resolved.selected,
          autoAdded,
          declined: resolved.declined,
          reason,
          actorUsername: input.actor,
          templateKey: input.template?.key ?? null,
          templateVersion: input.template?.version ?? null,
        },
      });
    });
  } catch (err) {
    if (err instanceof StaleVersion) return { error: STALE };
    throw err;
  }
  return { success: "Applied.", version: nextVersion, added: diff.added, removed: diff.removed, autoAdded, leftOut, projectType, projectBaseType: recordedBase };
}
